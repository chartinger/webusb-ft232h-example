import type { Ft232hI2c } from './ft232h';

export interface Calibration {
  T1: number;
  T2: number;
  T3: number;
  P1: number;
  P2: number;
  P3: number;
  P4: number;
  P5: number;
  P6: number;
  P7: number;
  P8: number;
  P9: number;
  H1: number;
  H2: number;
  H3: number;
  H4: number;
  H5: number;
  H6: number;
}

export interface Reading {
  temperature: number; // °C
  pressure: number; // hPa
  humidity: number; // % RH
}

const u16 = (b: Uint8Array, i: number): number => b[i] | (b[i + 1] << 8);
const s16 = (b: Uint8Array, i: number): number => (u16(b, i) << 16) >> 16;
const s8 = (value: number): number => (value << 24) >> 24;
const s12 = (value: number): number => (value << 20) >> 20;

export function parseCalibration(a: Uint8Array, h: Uint8Array): Calibration {
  if (a.length !== 26 || h.length !== 7) throw new Error('Incomplete BME280 calibration');
  return {
    T1: u16(a, 0),
    T2: s16(a, 2),
    T3: s16(a, 4),
    P1: u16(a, 6),
    P2: s16(a, 8),
    P3: s16(a, 10),
    P4: s16(a, 12),
    P5: s16(a, 14),
    P6: s16(a, 16),
    P7: s16(a, 18),
    P8: s16(a, 20),
    P9: s16(a, 22),
    H1: a[25],
    H2: s16(h, 0),
    H3: h[2],
    H4: s12((h[3] << 4) | (h[4] & 0x0f)),
    H5: s12((h[5] << 4) | (h[4] >> 4)),
    H6: s8(h[6]),
  };
}

function measurementNotReady(raw: Uint8Array): boolean {
  const adcP = (raw[0] << 12) | (raw[1] << 4) | (raw[2] >> 4);
  const adcT = (raw[3] << 12) | (raw[4] << 4) | (raw[5] >> 4);
  const adcH = (raw[6] << 8) | raw[7];
  return adcT === 0x80000 || adcP === 0x80000 || adcH === 0x8000;
}

export function compensate(raw: Uint8Array, c: Calibration): Reading {
  if (raw.length !== 8) throw new Error('Incomplete BME280 reading');
  const adcP = (raw[0] << 12) | (raw[1] << 4) | (raw[2] >> 4);
  const adcT = (raw[3] << 12) | (raw[4] << 4) | (raw[5] >> 4);
  const adcH = (raw[6] << 8) | raw[7];
  if (measurementNotReady(raw)) throw new Error('BME280 measurement is not ready yet');

  const t1 = (adcT / 16384 - c.T1 / 1024) * c.T2;
  const t2 = (adcT / 131072 - c.T1 / 8192) ** 2 * c.T3;
  const tFine = t1 + t2;
  const temperature = tFine / 5120;

  let v1 = tFine / 2 - 64000;
  let v2 = (v1 * v1 * c.P6) / 32768;
  v2 += v1 * c.P5 * 2;
  v2 = v2 / 4 + c.P4 * 65536;
  v1 = ((c.P3 * v1 * v1) / 524288 + c.P2 * v1) / 524288;
  v1 = (1 + v1 / 32768) * c.P1;
  if (v1 === 0) throw new Error('Invalid BME280 pressure calibration');
  let pressure = ((1048576 - adcP - v2 / 4096) * 6250) / v1;
  v1 = (c.P9 * pressure * pressure) / 2147483648;
  v2 = (pressure * c.P8) / 32768;
  pressure += (v1 + v2 + c.P7) / 16;

  let humidity = tFine - 76800;
  humidity =
    (adcH - (c.H4 * 64 + (c.H5 / 16384) * humidity)) *
    ((c.H2 / 65536) * (1 + (c.H6 / 67108864) * humidity * (1 + (c.H3 / 67108864) * humidity)));
  humidity *= 1 - (c.H1 * humidity) / 524288;
  humidity = Math.max(0, Math.min(100, humidity));
  return { temperature, pressure: pressure / 100, humidity };
}

export class Bme280 {
  private calibration: Calibration | null = null;

  constructor(
    private readonly bus: Pick<Ft232hI2c, 'readRegister' | 'writeRegister'>,
    readonly address = 0x76,
  ) {}

  async initialize(onStep: (step: string) => void = () => {}): Promise<void> {
    onStep('Reading BME280 chip ID…');
    const id = (await this.bus.readRegister(this.address, 0xd0, 1))[0];
    if (id !== 0x60)
      throw new Error(`Expected BME280 chip ID 0x60, got 0x${id.toString(16).padStart(2, '0')}`);
    onStep('Reading temperature and pressure calibration…');
    const a = await this.bus.readRegister(this.address, 0x88, 26);
    onStep('Reading humidity calibration…');
    const h = await this.bus.readRegister(this.address, 0xe1, 7);
    this.calibration = parseCalibration(a, h);
    onStep('Configuring BME280…');
    await this.bus.writeRegister(this.address, 0xf4, 0x00); // sleep before changing configuration
    await this.bus.writeRegister(this.address, 0xf5, 0x00); // no standby filter
    await this.bus.writeRegister(this.address, 0xf2, 0x01); // humidity x1 (must precede ctrl_meas)
    await this.bus.writeRegister(this.address, 0xf4, 0x27); // temperature x1, pressure x1, normal mode
  }

  async read(): Promise<Reading> {
    if (!this.calibration) throw new Error('BME280 has not been initialized');
    // The first normal-mode conversion may still be running immediately after
    // configuration. Retry only the sensor's unconverted-data sentinel.
    for (let attempt = 0; attempt < 4; attempt++) {
      const raw = await this.bus.readRegister(this.address, 0xf7, 8);
      if (raw.length !== 8 || !measurementNotReady(raw)) return compensate(raw, this.calibration);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return compensate(await this.bus.readRegister(this.address, 0xf7, 8), this.calibration);
  }
}
