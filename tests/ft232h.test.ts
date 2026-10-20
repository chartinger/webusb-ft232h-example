import test from 'node:test';
import assert from 'node:assert/strict';
import { Ft232hI2c } from '../src/lib/ft232h';

function fakeDevice(replies: number[], vendorId = 0x0403, productId = 0x6014) {
  const writes: number[][] = [];
  const controls: USBControlTransferParameters[] = [];
  let readCount = 0;
  // Only the WebUSB methods used by Ft232hI2c are needed in this test double.
  const mock = {
    vendorId,
    productId,
    opened: false,
    configuration: {
      interfaces: [
        {
          interfaceNumber: 0,
          alternates: [
            {
              alternateSetting: 0,
              endpoints: [
                { type: 'bulk', direction: 'in', endpointNumber: 1 },
                { type: 'bulk', direction: 'out', endpointNumber: 2 },
              ],
            },
          ],
        },
      ],
    },
    async open() {
      this.opened = true;
    },
    async claimInterface() {},
    async controlTransferOut(setup: USBControlTransferParameters) {
      controls.push(setup);
      return { status: 'ok' };
    },
    async transferOut(endpoint: number, bytes: BufferSource) {
      assert.equal(endpoint, 2);
      const data = bytes as Uint8Array;
      writes.push(Array.from(data));
      return { status: 'ok', bytesWritten: data.length };
    },
    async transferIn() {
      readCount++;
      // FTDI USB packets have two status bytes before the MPSSE reply.
      return { status: 'ok', data: new DataView(Uint8Array.from([0, 0, ...replies]).buffer) };
    },
  };
  const device = mock as unknown as USBDevice;
  return { device, writes, controls, getReadCount: () => readCount };
}

void test('reconnects to one already-authorized FT232H without showing a chooser', async () => {
  const { device } = fakeDevice([]);
  const usb = {
    async getDevices() {
      return [fakeDevice([], 0x1234, 0x5678).device, device];
    },
    async requestDevice() {
      throw new Error('chooser must not open');
    },
  };
  const bus = await Ft232hI2c.request(usb);
  assert.equal(bus.device, device);
  assert.equal(device.opened, true);
});

void test('requests permission when no matching device is already authorized', async () => {
  const { device } = fakeDevice([]);
  let chooserCalls = 0;
  const usb = {
    async getDevices(): Promise<USBDevice[]> {
      return [];
    },
    async requestDevice({ filters }: USBDeviceRequestOptions) {
      chooserCalls++;
      assert.deepEqual(filters, [{ vendorId: 0x0403, productId: 0x6014 }]);
      return device;
    },
  };
  await Ft232hI2c.request(usb);
  assert.equal(chooserCalls, 1);
});

void test('asks which board to use when multiple matching devices are authorized', async () => {
  const first = fakeDevice([]).device;
  const second = fakeDevice([]).device;
  const usb = {
    async getDevices() {
      return [first, second];
    },
    async requestDevice() {
      return second;
    },
  };
  assert.equal((await Ft232hI2c.request(usb)).device, second);
});

void test('initialization resets MPSSE and disables internal loopback', async () => {
  const { device, writes, controls } = fakeDevice([]);
  const bus = new Ft232hI2c(device);
  await bus.open();
  assert.deepEqual(
    controls.filter((c) => c.request === 0x0b).map((c) => c.value),
    [0, 0x0200],
  );
  assert.equal(writes[0][0], 0x85);
  assert.ok(writes[0].includes(0x8c));
  assert.ok(writes[0].includes(0x86));
});

void test('hardware-byte-clock chip-ID read accepts padded ACK replies', async () => {
  const { device, writes } = fakeDevice([0x80, 0xc0, 0, 0x60]);
  const bus = new Ft232hI2c(device);
  await bus.open();
  assert.deepEqual(Array.from(await bus.readRegister(0x76, 0xd0, 1)), [0x60]);
  const transaction = writes.slice(1).flat();
  for (const opcode of [0x11, 0x22, 0x20, 0x13]) assert.ok(transaction.includes(opcode));
});

void test('26-byte calibration read fits in one MPSSE transaction', async () => {
  const { device, getReadCount } = fakeDevice([0x80, 0xc0, 0, ...Array(26).fill(42)]);
  const bus = new Ft232hI2c(device);
  await bus.open();
  assert.deepEqual(Array.from(await bus.readRegister(0x76, 0x88, 26)), Array(26).fill(42));
  assert.equal(getReadCount(), 1);
});

void test('register write checks only bit 0 of each ACK', async () => {
  const bus = new Ft232hI2c(fakeDevice([0x80, 0xc0, 0]).device);
  await bus.open();
  await bus.writeRegister(0x76, 0xf4, 0x27);
  const nackBus = new Ft232hI2c(fakeDevice([0x80, 0x81, 0]).device);
  await nackBus.open();
  await assert.rejects(() => nackBus.writeRegister(0x76, 0xf4, 0x27), /NACK at register 0xf4/);
});

void test('SDA wiring check reads D2 when released and driven low', async () => {
  const bus = new Ft232hI2c(fakeDevice([0x04, 0x00]).device);
  await bus.open();
  await bus.probeLines();
  const noPullup = new Ft232hI2c(fakeDevice([0x00, 0x00]).device);
  await noPullup.open();
  await assert.rejects(() => noPullup.probeLines(), /SDA is low when released/);
});
