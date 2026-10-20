import test from 'node:test';
import assert from 'node:assert/strict';
import { Bme280, compensate, parseCalibration, type Calibration } from '../src/lib/bme280';

void test('Bosch datasheet temperature and pressure compensation example', () => {
  const raw = Uint8Array.from([0x65, 0x5a, 0xc0, 0x7e, 0xed, 0x00, 0x40, 0x00]); // P=415148, T=519888
  const calibration: Calibration = {
    T1: 27504,
    T2: 26435,
    T3: -1000,
    P1: 36477,
    P2: -10685,
    P3: 3024,
    P4: 2855,
    P5: 140,
    P6: -7,
    P7: 15500,
    P8: -14600,
    P9: 6000,
    H1: 0,
    H2: 0,
    H3: 0,
    H4: 0,
    H5: 0,
    H6: 0,
  };
  const result = compensate(raw, calibration);
  assert.ok(Math.abs(result.temperature - 25.08) < 0.02);
  assert.ok(Math.abs(result.pressure - 1006.53) < 0.03);
  assert.equal(result.humidity, 0);
});

void test('retries an unfinished first measurement after configuring the sensor', async () => {
  let reads = 0;
  const sensor = new Bme280({
    async readRegister(_address, register) {
      if (register === 0xd0) return Uint8Array.of(0x60);
      if (register === 0x88) {
        const calibration = new Uint8Array(26);
        calibration[6] = 1; // P1 must be nonzero
        return calibration;
      }
      if (register === 0xe1) return new Uint8Array(7);
      assert.equal(register, 0xf7);
      reads++;
      return reads === 1 ? Uint8Array.of(0x80, 0, 0, 0x80, 0, 0, 0x80, 0) : new Uint8Array(8);
    },
    async writeRegister() {},
  });
  await sensor.initialize();
  assert.ok(Number.isFinite((await sensor.read()).temperature));
  assert.equal(reads, 2);
});

void test('reports a sensor that never finishes its measurement', async () => {
  let reads = 0;
  const sensor = new Bme280({
    async readRegister(_address, register) {
      if (register === 0xd0) return Uint8Array.of(0x60);
      if (register === 0x88) return new Uint8Array(26);
      if (register === 0xe1) return new Uint8Array(7);
      reads++;
      return Uint8Array.of(0x80, 0, 0, 0x80, 0, 0, 0x80, 0);
    },
    async writeRegister() {},
  });
  await sensor.initialize();
  await assert.rejects(() => sensor.read(), /measurement is not ready yet/);
  assert.equal(reads, 5);
});

void test('signed humidity calibration is decoded from split nibbles', () => {
  const a = new Uint8Array(26);
  const h = Uint8Array.from([0xfe, 0xff, 5, 0xff, 0xff, 0xff, 0xfe]);
  a[25] = 42;
  const c = parseCalibration(a, h);
  assert.equal(c.H1, 42);
  assert.equal(c.H2, -2);
  assert.equal(c.H4, -1);
  assert.equal(c.H5, -1);
  assert.equal(c.H6, -2);
});
