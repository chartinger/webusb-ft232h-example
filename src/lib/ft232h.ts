// FT232H MPSSE: D0=SCL, D1=SDA output, D2=SDA input.
// SDA needs a pull-up; D1 becomes high-impedance when SDA is released.
const VID = 0x0403;
const PID = 0x6014;
const SET_BITMODE = 0x0b;
const SET_LATENCY_TIMER = 0x09;
const RESET = 0x00;
const SCL = 0x01;
const SDA_OUT = 0x02;

function timed<T>(promise: Promise<T>, action: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${action} timed out after 10 seconds`)), 10000);
    }),
  ]).finally(() => clearTimeout(timer));
}

function pins(sclHigh: boolean, sdaLow: boolean): number[] {
  return [0x80, sclHigh ? SCL : 0, SCL | (sdaLow ? SDA_OUT : 0)];
}

type Reply = { type: 'ack'; label: string } | { type: 'data' };

class I2cCommands {
  readonly bytes: number[] = [];
  readonly replies: Reply[] = [];

  push(...bytes: number[]): void {
    this.bytes.push(...bytes);
  }
  gpio(sclHigh: boolean, sdaLow: boolean): void {
    this.push(...pins(sclHigh, sdaLow));
  }
  hold(sclHigh: boolean, sdaLow: boolean): void {
    // START/STOP need more setup time than a single MPSSE GPIO command.
    for (let i = 0; i < 100; i++) this.gpio(sclHigh, sdaLow);
  }

  start(): void {
    this.hold(true, false);
    this.hold(true, true);
    this.hold(false, true);
  }

  stop(): void {
    this.hold(false, true);
    this.hold(true, true);
    this.hold(true, false);
  }

  writeByte(value: number, label: string): void {
    this.gpio(false, true);
    this.push(0x11, 0, 0, value); // MPSSE clocks one byte out
    this.gpio(false, false); // release SDA for slave ACK
    this.push(0x22, 0); // MPSSE clocks one bit in
    this.replies.push({ type: 'ack', label });
  }

  readByte(last: boolean): void {
    this.gpio(false, false);
    this.push(0x20, 0, 0); // MPSSE clocks one byte in
    this.replies.push({ type: 'data' });
    this.gpio(false, !last);
    this.push(0x13, 0, last ? 0xff : 0x00); // NACK the last byte, ACK otherwise
    this.gpio(false, false);
  }
}

export class Ft232hI2c {
  private interfaceNumber: number | null = null;
  private endpointIn: number | null = null;
  private endpointOut: number | null = null;
  private usbFailed = false;

  constructor(readonly device: USBDevice) {}

  static async request(
    usb: Pick<USB, 'getDevices' | 'requestDevice'> = navigator.usb,
  ): Promise<Ft232hI2c> {
    const authorized = (await usb.getDevices()).filter(
      (device) => device.vendorId === VID && device.productId === PID,
    );
    // getDevices() returns only devices already permitted for this origin.
    // Avoid the chooser for one known FT232H; let the user choose if ambiguous.
    const device =
      authorized.length === 1
        ? authorized[0]
        : await usb.requestDevice({ filters: [{ vendorId: VID, productId: PID }] });
    const bus = new Ft232hI2c(device);
    try {
      await bus.open();
      return bus;
    } catch (error) {
      try {
        await bus.close();
      } catch {
        /* preserve the original connection error */
      }
      throw error;
    }
  }

  async open(): Promise<void> {
    await this.device.open();
    if (!this.device.configuration) await this.device.selectConfiguration(1);
    const configuration = this.device.configuration;
    if (!configuration) throw new Error('FT232H USB configuration not found');
    const match = configuration.interfaces
      .flatMap((iface) => iface.alternates.map((alt) => ({ iface, alt })))
      .find(
        ({ alt }) =>
          alt.endpoints.some((e) => e.type === 'bulk' && e.direction === 'in') &&
          alt.endpoints.some((e) => e.type === 'bulk' && e.direction === 'out'),
      );
    if (!match) throw new Error('FT232H bulk USB endpoints not found');
    const endpointIn = match.alt.endpoints.find((e) => e.type === 'bulk' && e.direction === 'in');
    const endpointOut = match.alt.endpoints.find((e) => e.type === 'bulk' && e.direction === 'out');
    if (!endpointIn || !endpointOut) throw new Error('FT232H bulk USB endpoints not found');
    this.interfaceNumber = match.iface.interfaceNumber;
    this.endpointIn = endpointIn.endpointNumber;
    this.endpointOut = endpointOut.endpointNumber;
    await this.device.claimInterface(this.interfaceNumber);
    if (match.alt.alternateSetting !== 0)
      await this.device.selectAlternateInterface(this.interfaceNumber, match.alt.alternateSetting);

    await this.control(RESET, 0);
    await this.control(RESET, 1); // purge RX
    await this.control(RESET, 2); // purge TX
    await this.control(SET_LATENCY_TIMER, 2);
    await this.control(SET_BITMODE, 0);
    await this.control(SET_BITMODE, 0x0200); // MPSSE mode
    // Disable internal loopback and /5 and adaptive clocking; enable 3-phase I²C.
    // 60 MHz / (3 * (199 + 1)) = 100 kHz.
    await this.send([0x85, 0x8a, 0x97, 0x8c, 0x86, 199, 0, 0x82, 0, 0, ...pins(true, false)]);
  }

  private async control(request: number, value: number): Promise<void> {
    if (this.interfaceNumber === null) throw new Error('FT232H interface not selected');
    const result = await this.device.controlTransferOut({
      requestType: 'vendor',
      recipient: 'device',
      request,
      value,
      index: this.interfaceNumber + 1,
    });
    if (result.status !== 'ok') throw new Error(`FT232H control transfer failed: ${result.status}`);
  }

  private async send(bytes: number[]): Promise<void> {
    if (this.endpointOut === null) throw new Error('FT232H USB OUT endpoint not found');
    const payload = new Uint8Array(bytes);
    // Keep writes below one high-speed USB packet (512 bytes). Large bulk OUT
    // transfers can stall in Chrome on Android; MPSSE accepts a byte stream
    // across multiple USB transfers, including across command boundaries.
    const chunkSize = 256;
    for (let offset = 0; offset < payload.length; offset += chunkSize) {
      const chunk = payload.subarray(offset, offset + chunkSize);
      try {
        const result = await timed(
          this.device.transferOut(this.endpointOut, chunk),
          'FT232H USB write',
        );
        if (result.status !== 'ok' || result.bytesWritten !== chunk.length)
          throw new Error('FT232H USB write failed');
      } catch (error) {
        this.usbFailed = true;
        throw error;
      }
    }
  }

  private async receive(count: number): Promise<number[]> {
    if (this.endpointIn === null) throw new Error('FT232H USB IN endpoint not found');
    const replies: number[] = [];
    while (replies.length < count) {
      const result = await timed(this.device.transferIn(this.endpointIn, 512), 'FT232H USB read');
      if (result.status !== 'ok' || !result.data || result.data.byteLength < 2) {
        throw new Error('FT232H USB read failed');
      }
      const packet = new Uint8Array(
        result.data.buffer,
        result.data.byteOffset,
        result.data.byteLength,
      );
      // Every FTDI USB packet begins with two modem/line-status bytes.
      for (let offset = 0; offset < packet.length; offset += 512) {
        replies.push(...packet.subarray(offset + 2, Math.min(offset + 512, packet.length)));
      }
    }
    if (replies.length !== count) throw new Error('Unexpected FT232H response length');
    return replies;
  }

  async probeLines(): Promise<void> {
    // Check SDA high when released and low when driven by D1. Keep SCL low
    // throughout: this does not send a START to the sensor.
    await this.send([
      ...pins(false, false),
      0x81,
      ...pins(false, true),
      0x81,
      ...pins(false, false),
      ...pins(true, false),
      0x87,
    ]);
    const [released, drivenLow] = await this.receive(2);
    if (!(released & 0x04)) {
      throw new Error(
        'SDA is low when released. Check 3.3 V power, SDA pull-up, and wiring (D1/D2).',
      );
    }
    if (drivenLow & 0x04) {
      throw new Error(
        'D2 does not see D1 pulling SDA low. Set the FT232H I²C switch ON, or connect D1 and D2 together.',
      );
    }
  }

  private async execute(commands: I2cCommands, address: number): Promise<Uint8Array> {
    // 0x87 flushes short replies without waiting for a full USB packet.
    await this.send([...commands.bytes, ...(commands.replies.length ? [0x87] : [])]);
    const replies = await this.receive(commands.replies.length);
    const data: number[] = [];
    replies.forEach((value, index) => {
      const reply = commands.replies[index];
      if (reply.type === 'ack') {
        // Only bit 0 of an MPSSE one-bit read is the ACK. Other bits may
        // contain nonzero padding (e.g. 0x80 and 0xc0 still mean ACK).
        if (value & 0x01)
          throw new Error(`I²C NACK at ${reply.label} (address 0x${address.toString(16)})`);
      } else {
        data.push(value);
      }
    });
    return new Uint8Array(data);
  }

  async readRegister(address: number, register: number, length: number): Promise<Uint8Array> {
    if (length < 1 || length > 128) throw new RangeError('Invalid I²C read length');
    const cmd = new I2cCommands();
    cmd.start();
    cmd.writeByte(address << 1, 'device address (write)');
    cmd.writeByte(register, `register 0x${register.toString(16)}`);
    cmd.start(); // repeated START
    cmd.writeByte((address << 1) | 1, 'device address (read)');
    for (let i = 0; i < length; i++) cmd.readByte(i === length - 1);
    cmd.stop();
    return this.execute(cmd, address);
  }

  async writeRegister(address: number, register: number, value: number): Promise<void> {
    const cmd = new I2cCommands();
    cmd.start();
    cmd.writeByte(address << 1, 'device address (write)');
    cmd.writeByte(register, `register 0x${register.toString(16)}`);
    cmd.writeByte(value, `value for register 0x${register.toString(16)}`);
    cmd.stop();
    await this.execute(cmd, address);
  }

  async close(): Promise<void> {
    if (!this.device.opened) return;
    try {
      if (this.interfaceNumber !== null && !this.usbFailed) {
        await this.send([...pins(true, false), 0x85, 0x8d]); // release SDA, disable MPSSE clock features
        await this.control(SET_BITMODE, 0);
        await this.device.releaseInterface(this.interfaceNumber);
      }
    } finally {
      await this.device.close();
    }
  }
}
