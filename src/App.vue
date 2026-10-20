<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Ft232hI2c } from './lib/ft232h';
import { Bme280, type Reading } from './lib/bme280';

const supported = typeof navigator !== 'undefined' && 'usb' in navigator && window.isSecureContext;
const address = ref('0x76');
const status = ref('Disconnected');
const error = ref('');
const reading = ref<Reading | null>(null);
const updated = ref<Date | null>(null);
const busy = ref(false);
const connected = ref(false);
const fahrenheit = ref(false);
let bus: Ft232hI2c | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

const temperature = computed(
  () =>
    reading.value &&
    (fahrenheit.value
      ? (reading.value.temperature * 9) / 5 + 32
      : reading.value.temperature
    ).toFixed(1),
);
const time = computed(() => updated.value?.toLocaleTimeString() ?? '—');
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function stop() {
  generation++;
  if (timer !== null) clearTimeout(timer);
  timer = null;
  const oldBus = bus;
  bus = null;
  connected.value = false;
  reading.value = null;
  updated.value = null;
  status.value = 'Disconnected';
  if (oldBus) {
    try {
      await oldBus.close();
    } catch (e) {
      error.value += `${error.value ? ' · ' : ''}Could not close USB device: ${errorMessage(e)}`;
    }
  }
}

async function connect() {
  if (busy.value || connected.value) return;
  busy.value = true;
  error.value = '';
  status.value = 'Connecting…';
  const session = ++generation;
  try {
    const device = await Ft232hI2c.request();
    if (session !== generation) {
      await device.close();
      return;
    }
    bus = device;
    status.value = 'Checking I²C wiring…';
    await device.probeLines();
    status.value = 'Initializing BME280…';
    const sensor = new Bme280(device, Number(address.value));
    await sensor.initialize((step) => {
      status.value = step;
    });
    if (session !== generation) return;
    connected.value = true;
    status.value = 'Live · updating every second';
    async function poll() {
      if (session !== generation) return;
      try {
        reading.value = await sensor.read();
        updated.value = new Date();
        error.value = '';
        if (session === generation) timer = setTimeout(poll, 1000);
      } catch (e) {
        if (session === generation) {
          error.value = errorMessage(e);
          await stop();
        }
      }
    }
    await poll();
  } catch (e) {
    if (session === generation) {
      error.value =
        e instanceof Error && e.name === 'NotFoundError' ? 'No device selected.' : errorMessage(e);
      await stop();
    }
  } finally {
    busy.value = false;
  }
}

function onUsbDisconnect(event: USBConnectionEvent) {
  if (event.device === bus?.device) {
    error.value = 'FT232H disconnected.';
    void stop();
  }
}

onMounted(() => {
  if (supported) navigator.usb.addEventListener('disconnect', onUsbDisconnect);
});
onUnmounted(() => {
  if (supported) navigator.usb.removeEventListener('disconnect', onUsbDisconnect);
  void stop();
});
</script>

<template>
  <main class="shell">
    <header class="header">
      <div class="brand">
        <span class="brand-icon">◈</span> ATMOS <span class="brand-sub">/ SENSOR MONITOR</span>
      </div>
      <span class="badge" :class="{ online: connected }"
        ><span class="dot"></span>{{ connected ? 'CONNECTED' : 'OFFLINE' }}</span
      >
    </header>

    <section class="intro">
      <p class="eyebrow">FT232H <span>→</span> I²C <span>→</span> BME280</p>
      <h1>Know your <em>environment.</em></h1>
      <p class="description">
        Real-time temperature, humidity, and atmospheric pressure. Straight from your sensor to your
        browser.
      </p>
    </section>

    <section class="connection panel" aria-label="Device connection">
      <div class="connection-info">
        <span class="section-label">01 / DEVICE CONNECTION</span>
        <div class="device-line">
          <span class="device-icon">⌁</span>
          <div>
            <strong>FT232H USB bridge</strong><small>{{ status }}</small>
          </div>
        </div>
      </div>
      <div class="connection-actions">
        <div class="connection-field">
          <label for="address">I²C ADDRESS</label
          ><select id="address" v-model="address" :disabled="connected || busy">
            <option value="0x76">0x76</option>
            <option value="0x77">0x77</option>
          </select>
        </div>
        <button v-if="!connected" class="primary" :disabled="!supported || busy" @click="connect">
          {{ busy ? 'Connecting…' : 'Connect device ↗' }}
        </button>
        <button v-else class="secondary" @click="stop">Disconnect</button>
      </div>
    </section>
    <p v-if="!supported" class="alert" role="alert">
      WebUSB requires a compatible Chromium browser on localhost or HTTPS.
    </p>
    <p v-if="error" class="alert" role="alert">{{ error }}</p>
    <div class="readings-head">
      <span class="section-label">02 / LIVE READINGS</span
      ><span class="timestamp">LAST UPDATED &nbsp;{{ time }}</span>
    </div>
    <section class="grid" aria-label="Sensor readings">
      <article class="metric panel temp">
        <div class="metric-top"><span>TEMPERATURE</span><span class="metric-symbol">↗</span></div>
        <div class="metric-value">
          {{ reading ? temperature : '—' }}<span v-if="reading">°{{ fahrenheit ? 'F' : 'C' }}</span>
        </div>
        <div class="metric-foot">
          <span>Ambient air temperature</span
          ><button class="unit-toggle" type="button" @click="fahrenheit = !fahrenheit">
            °C / °F
          </button>
        </div>
      </article>
      <article class="metric panel humidity">
        <div class="metric-top"><span>HUMIDITY</span><span class="metric-symbol">◌</span></div>
        <div class="metric-value">
          {{ reading ? reading.humidity.toFixed(1) : '—' }}<span v-if="reading">%</span>
        </div>
        <div class="metric-foot">Relative humidity</div>
      </article>
      <article class="metric panel pressure">
        <div class="metric-top"><span>PRESSURE</span><span class="metric-symbol">◎</span></div>
        <div class="metric-value">
          {{ reading ? reading.pressure.toFixed(1) : '—' }}<span v-if="reading">hPa</span>
        </div>
        <div class="metric-foot">Barometric pressure</div>
      </article>
    </section>

    <footer>
      <span>LOCAL DATA ONLY · NO CLOUD CONNECTION</span><span>BME280 / FT232H / WEBUSB</span>
    </footer>
  </main>
</template>
