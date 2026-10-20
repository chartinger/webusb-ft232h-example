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
  <main class="mx-auto flex min-h-screen max-w-shell min-w-80 flex-col px-8 max-mobile:px-5">
    <header
      class="flex h-22 items-center justify-between border-b border-border-subtle max-mobile:h-18"
    >
      <div class="text-lg font-bold tracking-brand">
        <span class="mr-2 text-2xl text-status-accent align-middle">◈</span> ATMOS
        <span
          class="ml-2 font-mono text-caption font-normal tracking-label text-brand-caption max-mobile:hidden"
          >/ SENSOR MONITOR</span
        >
      </div>
      <span
        class="flex items-center gap-2 rounded-full border px-3.5 py-2.5 font-mono text-label"
        :class="
          connected
            ? 'border-status-border text-status-online'
            : 'border-badge-border text-status-offline'
        "
        ><span
          class="size-2 rounded-full"
          :class="connected ? 'bg-status-accent shadow-status' : 'bg-status-dot'"
        ></span
        >{{ connected ? 'CONNECTED' : 'OFFLINE' }}</span
      >
    </header>

    <section class="pt-10 pb-14 max-mobile:pt-8 max-mobile:pb-11">
      <p class="mb-6 font-mono text-label tracking-label text-eyebrow">
        FT232H <span class="mx-2.5 text-eyebrow-divider">→</span> I²C
        <span class="mx-2.5 text-eyebrow-divider">→</span> BME280
      </p>
      <h1 class="mb-5 text-hero leading-tight font-semibold tracking-hero">
        Know your <em class="not-italic text-heading-accent">environment.</em>
      </h1>
      <p class="m-0 max-w-xl text-base leading-relaxed text-copy">
        Real-time temperature, humidity, and atmospheric pressure. Straight from your sensor to your
        browser.
      </p>
    </section>

    <section
      class="flex min-h-36 items-center justify-between gap-6 panel px-8 py-6 max-mobile:flex-col max-mobile:items-stretch"
      aria-label="Device connection"
    >
      <div>
        <span class="font-mono text-label tracking-label text-muted">01 / DEVICE CONNECTION</span>
        <div class="mt-5 flex items-center gap-4">
          <span
            class="grid size-11 place-items-center rounded-lg bg-device-icon-bg text-3xl text-device-icon"
            >⌁</span
          >
          <div>
            <strong class="block text-base font-semibold">FT232H USB bridge</strong
            ><small class="mt-1 block text-xs text-secondary-copy">{{ status }}</small>
          </div>
        </div>
      </div>
      <div class="flex flex-wrap items-end justify-end gap-3 max-mobile:justify-between">
        <div class="flex flex-col gap-2">
          <label class="font-mono text-label tracking-label text-field-label" for="address"
            >I²C ADDRESS</label
          ><select
            id="address"
            v-model="address"
            class="h-11 rounded-md border border-border-field bg-field-bg py-0 pr-7 pl-3 text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="connected || busy"
          >
            <option value="0x76">0x76</option>
            <option value="0x77">0x77</option>
          </select>
        </div>
        <button
          v-if="!connected"
          class="h-11 cursor-pointer rounded-md bg-accent px-6 font-bold whitespace-nowrap text-accent-ink hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 max-narrow:flex-1"
          :disabled="!supported || busy"
          @click="connect"
        >
          {{ busy ? 'Connecting…' : 'Connect device ↗' }}
        </button>
        <button
          v-else
          class="h-11 cursor-pointer rounded-md bg-secondary px-6 font-bold whitespace-nowrap text-foreground hover:bg-secondary-hover max-narrow:flex-1"
          @click="stop"
        >
          Disconnect
        </button>
      </div>
    </section>
    <p
      v-if="!supported"
      class="rounded-lg border border-alert-border bg-alert-bg px-4 py-3.5 text-sm text-alert-text"
      role="alert"
    >
      WebUSB requires a compatible Chromium browser on localhost or HTTPS.
    </p>
    <p
      v-if="error"
      class="rounded-lg border border-alert-border bg-alert-bg px-4 py-3.5 text-sm text-alert-text"
      role="alert"
    >
      {{ error }}
    </p>
    <div class="mt-16 mb-4 flex items-center justify-between max-mobile:mt-11">
      <span class="font-mono text-label tracking-label text-muted">02 / LIVE READINGS</span
      ><span class="font-mono text-label tracking-label text-timestamp max-mobile:text-caption"
        >LAST UPDATED &nbsp;{{ time }}</span
      >
    </div>
    <section class="grid grid-cols-3 gap-4 max-mobile:grid-cols-1" aria-label="Sensor readings">
      <article class="metric-card">
        <div class="metric-top">
          <span>TEMPERATURE</span
          ><span class="font-sans text-2xl leading-4 text-temperature">↗</span>
        </div>
        <div class="metric-value">
          {{ reading ? temperature : '—'
          }}<span v-if="reading" class="metric-unit">°{{ fahrenheit ? 'F' : 'C' }}</span>
        </div>
        <div class="metric-foot">
          <span>Ambient air temperature</span
          ><button
            class="cursor-pointer p-0 text-unit-toggle hover:underline"
            type="button"
            @click="fahrenheit = !fahrenheit"
          >
            °C / °F
          </button>
        </div>
      </article>
      <article class="metric-card">
        <div class="metric-top">
          <span>HUMIDITY</span><span class="font-sans text-2xl leading-4 text-humidity">◌</span>
        </div>
        <div class="metric-value">
          {{ reading ? reading.humidity.toFixed(1) : '—'
          }}<span v-if="reading" class="metric-unit">%</span>
        </div>
        <div class="metric-foot">Relative humidity</div>
      </article>
      <article class="metric-card">
        <div class="metric-top">
          <span>PRESSURE</span><span class="font-sans text-2xl leading-4 text-pressure">◎</span>
        </div>
        <div class="metric-value">
          {{ reading ? reading.pressure.toFixed(1) : '—'
          }}<span v-if="reading" class="metric-unit">hPa</span>
        </div>
        <div class="metric-foot">Barometric pressure</div>
      </article>
    </section>

    <footer
      class="mt-auto flex justify-between gap-5 border-t border-border-subtle py-6 font-mono text-label tracking-wide text-footer max-narrow:text-caption"
    >
      <span class="pt-12 max-mobile:pt-10">LOCAL DATA ONLY · NO CLOUD CONNECTION</span
      ><span class="pt-12 max-mobile:pt-10">BME280 / FT232H / WEBUSB</span>
    </footer>
  </main>
</template>
