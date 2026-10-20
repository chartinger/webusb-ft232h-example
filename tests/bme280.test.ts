import test from 'node:test';
import assert from 'node:assert/strict';
import { compensate, parseCalibration, type Calibration } from '../src/lib/bme280';

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
