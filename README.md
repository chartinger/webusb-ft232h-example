# BME280 WebUSB Monitor

Vue 3 + TypeScript app that reads a BME280 temperature / humidity / pressure sensor over I²C using an FT232H USB bridge. No server-side sensor software is needed.

## Wiring (3.3 V only)

| FT232H                                 | BME280 breakout                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 3V3                                    | VIN / VCC (only if your breakout accepts 3.3 V)                                                         |
| GND                                    | GND                                                                                                     |
| D0 (SCL)                               | SCL / SCK                                                                                               |
| D1 (SDA output) **and D2 (SDA input)** | SDA / SDI (on Adafruit's USB-C FT232H board, set the I2C switch **ON** to connect D1 and D2 internally) |
| —                                      | CS / CSB → 3V3 (I²C mode)                                                                               |
| —                                      | SDO → GND for address `0x76`, or 3V3 for `0x77`                                                         |

SDA **must** have a pull-up to 3.3 V (typically 4.7 kΩ); add a pull-up to SCL too. Many BME280 breakout boards already provide these resistors: check yours first. The FT232H releases D1 to input/high-impedance when SDA should be high, so the pull-up is essential. Connect D1 and D2 **together** at SDA unless your FT232H board has an I2C switch that connects them internally; in that case, set the switch **ON** and wire SDA to D1. The switch connects the pins; it does not replace the need for SDA pull-ups. Never connect the BME280 directly to 5 V logic. If your breakout has no voltage regulator, power it from 3.3 V only.

## GitHub Pages

The site is deployed from `main` by `.github/workflows/deploy.yml` to https://chartinger.github.io/webusb-ft232h-example/. In the repository's **Settings → Pages**, set **Build and deployment → Source** to **GitHub Actions**. Push to `main` (or run the workflow manually) to publish it. Vite's `base` is set to `/webusb-ft232h-example/` so assets resolve under the repository URL. GitHub Pages serves over HTTPS, as required by WebUSB; use a desktop Chromium-based browser to connect the sensor.

## Run

```sh
npm install
npm run dev
```

Open the Vite localhost URL in a desktop Chromium-based browser with WebUSB support, select the sensor address (`0x76` or `0x77`), and click **Connect device**. WebUSB requires a secure context (`localhost` or HTTPS). Chrome prompts on first use; if exactly one FT232H is already authorized for the site, later connections skip the chooser. Chrome may ask again after permission is revoked or if multiple matching boards are connected. Readings update every second. `npm run typecheck` checks TypeScript and Vue components; `npm test` runs the TypeScript tests; `npm run build` typechecks and produces the static site in `dist/`. Run `npm run lint` to lint TypeScript and Vue files with Oxlint (including type-aware TypeScript rules), `npm run format:check` to check formatting, or `npm run format` to apply Oxfmt. The app uses Vite 8, Vue 3, and Tailwind CSS v4 via the Vite plugin. Styles use Tailwind utilities in `src/App.vue`; `src/style.css` defines semantic color/type tokens, mobile breakpoints, and reusable metric-card utilities. Most spacing uses Tailwind's default scale; no Tailwind config file is needed. TypeScript is constrained to v6 (`^6.0.3`), so it cannot upgrade to TypeScript 7.

On Linux you may need a udev rule granting access to FTDI USB VID `0403`, PID `6014`, and to detach the kernel `ftdi_sio` driver. On Windows a compatible WinUSB driver may be required for the FT232H; replacing the driver can affect other FTDI applications. On macOS, an OS driver or other program may claim the device. Close any other FTDI software before connecting. WebUSB support and driver binding differ by OS and browser.

I²C bytes are clocked by the FT232H's MPSSE engine. GPIO commands are still needed for I²C START/STOP conditions and the SDA wiring check; they are not used to clock each data bit. The ACK returned by MPSSE command `0x22` is in bit 0; the other bits may be nonzero. This implementation assumes a single I²C master and does not implement clock stretching. It identifies genuine BME280 devices by chip ID `0x60` (a BMP280 does not measure humidity). All sensor data stays in your browser.
