# Ronning X27 Pro — Hardware & Bluetooth Reference

## Treadmill Identity

| Field | Value |
|---|---|
| Brand | Ronning (of Scandinavia) / Nordic Sports Group AS |
| Model | X27 Pro |
| OEM Platform | FITSHOW (Xiamen) |
| BLE Module | FS-BT-T4, firmware 1.3.8 |
| BLE Name | FS-A58A49 (BLE), FS-A58A49-A (Classic Audio) |
| BLE Address | <your-ble-address> (BLE), <your-bt-classic-address> (Classic) |
| Console PCB | G-WAY (Jiwei Electronic) GWC-CP1270C1-TRD, V1, 2025/07/03 |
| Console MCU | HTC1740 / 4A123A |
| BT Audio Chip | BL25CM1 |
| Model Codes | TP243H/W25421, P3056, TRD-1270C2/25091900519 |

## Motor & Drive

| Component | Specs |
|---|---|
| Main Motor | TP142-1.25HP, DC Permanent Magnet, 180V, 5.0A, 5200 RPM, CW rotation |
| Motor S/N | <motor-serial> |
| Incline Motor | GPFE model, 220V AC with gearbox |
| Speed Range | 1.0 — 14.0 km/h (0.1 km/h increments) |
| Incline Range | 0 — 12% (1% increments) |
| Max User Weight | 140 kg |
| Belt Size | 430 x 1200 mm |
| EMI Filter | HENG JU, line filter |

## Console Hardware

- Two **4 ohm 5W speakers** (not piezo buzzers) connected via CN3 ("USB MUSIC POWER")
- Speaker is driven by an amplifier IC on the console PCB
- All sounds (beeps, Bluetooth audio) go through the same amplifier/speaker
- CN3 is a simple white 3-pin plug connector — easy to disconnect

## Board Architecture

```
Console PCB (G-WAY GWC-CP1270C1-TRD)
├── HTC1740 MCU — touch/button input, display, beep generation
├── BL25CM1 — Bluetooth audio (A2DP sink, AVRCP)
├── FS-BT-T4 module (blue daughter board at CN1) — BLE (FTMS + FFF0)
├── CN3 — speaker connector (USB MUSIC POWER)
├── CN5 — 12V/GND power input
├── CN10 — VO/V+/IN (unpopulated, likely for expansion)
├── Yellow multi-pin connector — UART to motor controller
└── Flat cable — to display/LED panel

Motor Controller PCB (in base)
├── DC motor driver (MOSFET/IGBT, PWM)
├── Incline motor relay/driver
├── Safety key circuit
├── Speed sensor input
└── UART to console (via multi-wire cable)
```

## Bluetooth Profiles

### BLE (Low Energy) — address <your-ble-address>

| Service | UUID | Purpose |
|---|---|---|
| Generic Access | 0x1800 | Device name "FS-A58A49" |
| Device Information | 0x180A | Manufacturer: FITSHOW, Model: FS-BT-T4, FW: 1.3.8, HW: 1.0, Serial: <serial> |
| FTMS | 0x1826 | Standard Fitness Machine Service (10 characteristics) |
| Custom FFF0 | 0xFFF0 | FITSHOW proprietary protocol (FFF1 notify, FFF2 write) |

### Bluetooth Classic — address <your-bt-classic-address>

| Profile | UUID | Purpose |
|---|---|---|
| A2DP Audio Sink | 0x110B | Receives and plays audio from connected source |
| AVRCP Target | 0x110C | Accepts remote control commands (play/pause/volume) |
| AVRCP Controller | 0x110E | Sends control commands back |
| PnP Information | 0x1200 | Vendor: 0x05D6, Product: 0x000A |

**Device Class:** 0x00240414 (Audio/Video — Loudspeaker)
**Modalias:** bluetooth:v05D6p000Ad0240

## FTMS Capabilities (0x1826)

| Characteristic | UUID | Data |
|---|---|---|
| Machine Feature | 0x2ACC | Speed, Incline, Distance, Calories, HR, Elapsed Time, Power |
| Treadmill Data | 0x2ACD | NOTIFY — live metrics |
| Training Status | 0x2AD3 | READ+NOTIFY |
| Machine Status | 0x2ADA | NOTIFY — start/stop/speed/incline confirmations |
| Control Point | 0x2AD9 | WRITE+INDICATE — commands |
| Speed Range | 0x2AD4 | Min: 1.00, Max: 14.00, Step: 0.10 km/h |
| Incline Range | 0x2AD5 | Min: 0.0%, Max: 12.0%, Step: 1.0% |
| Resistance Range | 0x2AD6 | 0–255, step 1 |
| Power Range | 0x2AD8 | 10–9999W, step 10W |
| HR Range | 0x2AD7 | 0–250 BPM, step 1 |

### FTMS Control Point Commands

| Command | Opcode | Parameters |
|---|---|---|
| Set Speed | 0x02 | uint16LE: speed * 100 (km/h) |
| Set Incline | 0x03 | int16LE: incline * 10 (%) |
| Start/Resume | 0x07 | (none) |
| Stop | 0x08, 0x01 | |
| Pause | 0x08, 0x02 | |
| Reset | 0x01 | (none) |

### FTMS Status Codes

| Code | Meaning |
|---|---|
| 0x01 | Reset |
| 0x02 | Stopped (triggers auto-end session) |
| 0x04 | Started (triggers auto-start if workout loaded) |
| 0x0A | Target Speed Changed (confirmation) |
| 0x0B | Target Incline Changed (confirmation) |

## FITSHOW Proprietary Protocol (FFF0)

### Packet Format

```
[0x02] [payload bytes...] [XOR checksum] [0x03]
```

Checksum = XOR of all payload bytes. Max packet size: 25 bytes.

### System Commands

| Command | First Byte | Purpose |
|---|---|---|
| SYS_INFO | 0x50 | Query device information |
| SYS_STATUS | 0x51 | Query/receive status + running data |
| SYS_DATA | 0x52 | Sport data exchange |
| SYS_CONTROL | 0x53 | Control (start/stop/speed/incline) |
| SYS_KEY | 0x54 | Key/button simulation (accepted but no effect on this model) |

### Info Queries (0x50, sub)

| Sub | Response on this treadmill |
|---|---|
| 0x00 (Model) | Returns 00-0000 (blank) |
| 0x01 (Factory Date) | Echo only (not supported) |
| 0x02 (Speed Limits) | **Max: 14.0, Min: 1.0 km/h** |
| 0x03 (Incline Limits) | **Max: 12%, Min: 0%, Pause: no** |
| 0x04 (Total Distance) | Echo only (not supported) |
| 0x05 (Extended Info) | Echo only (not supported) |
| 0x06–0x0F | Echo only |

### Control Commands (0x53, sub)

| Sub | Payload | Purpose |
|---|---|---|
| 0x00 | [id_lo, id_hi, 110, age, weight, height] | User data |
| 0x01 | [sportID x4, mode, blocks, 0, 0] | Start treadmill |
| 0x02 | [speed*10, incline] | Set target speed + incline |
| 0x03 | (none) | Stop |
| 0x06 | (none) | Pause |

### Status Values (from SYS_STATUS response)

| Code | Meaning |
|---|---|
| 0 | Idle/standby |
| 1 | Workout ended |
| 2 | Starting (countdown) |
| 3 | Running |
| 4 | Stopped |
| 5 | Error (errno in byte[2]) |
| 6 | Safety key removed |
| 7 | Calibration/study mode |
| 10 | Paused |

### Error Codes

| Code | Meaning |
|---|---|
| 1 | E01 — Signal cable fault |
| 2 | E02 — Control board fault |
| 3 | E03 — Speed sensor fault |
| 100 | Safety key removed |

### Running Data (status response, 13+ bytes)

| Offset | Field | Encoding |
|---|---|---|
| [2] | Speed | value / 10 (km/h) |
| [3] | Incline | signed int8 (%) |
| [4–5] | Elapsed time | uint16LE (seconds) |
| [6–7] | Distance | uint16LE / 10 (km) |
| [8–9] | Calories | uint16LE |
| [10–11] | Steps | uint16LE |
| [12] | Heart rate | uint8 BPM |

### What This Model Does NOT Support via FFF0

- Lifetime total distance (0x50, 0x04)
- Factory date (0x50, 0x01)
- Extended info / HRC / countdown (0x50, 0x05)
- Key/button simulation (0x54) — accepted but no effect
- Undocumented commands 0x40–0x4F, 0x55–0x5F — all echo back without effect
- Volume control — not available via BLE

## Audio / A2DP Integration

### Connection

The treadmill exposes a Bluetooth Classic A2DP audio sink alongside BLE. Both connections can be active simultaneously (different addresses, same physical Bluetooth chip).

```bash
# Pair and connect (one-time)
sudo bluetoothctl trust <your-bt-classic-address>
sudo bluetoothctl pair <your-bt-classic-address>
sudo bluetoothctl connect <your-bt-classic-address>

# Requires PulseAudio with Bluetooth module
sudo apt-get install pulseaudio pulseaudio-module-bluetooth
sudo pulseaudio --start --exit-idle-time=-1
```

### PulseAudio Sink

Once connected, the treadmill appears as:
```
bluez_sink.<your-bt-sink-id>.a2dp_sink
```

### Volume Control

```bash
# Set volume (0-100%)
pactl set-sink-volume bluez_sink.<your-bt-sink-id>.a2dp_sink 50%

# Mute/unmute
pactl set-sink-mute bluez_sink.<your-bt-sink-id>.a2dp_sink toggle

# Set as default output
pactl set-default-sink bluez_sink.<your-bt-sink-id>.a2dp_sink
```

### Playing Audio

```bash
# Text-to-speech (robotic but functional)
espeak-ng -v en -s 150 "Starting interval in 10 seconds" --stdout | paplay

# Play WAV/OGA file
paplay /path/to/sound.wav

# speaker-test (sine tone)
speaker-test -t sine -f 440 -D pulse -l 1 -p 2
```

### Important Notes

- A2DP volume does NOT affect the built-in beep volume — beeps are generated locally by the MCU
- To silence beeps: disconnect the speaker from CN3, or add a series resistor (15-22 ohm)
- A2DP audio and BLE FTMS/FFF0 coexist on separate Bluetooth addresses
- PulseAudio must be running for A2DP to work

## Motivasjonscoach — Feature Possibilities

### What We Can Build

With the A2DP audio connection and BLE sensor data, a voice coaching system can:

1. **Segment announcements** — "Interval 3 starting. Target speed: 12 km/h"
2. **Heart rate zone coaching** — "Heart rate 175, you're in zone 5. Slow down."
3. **Progress updates** — "Halfway done. 2.3 km covered."
4. **Motivational cues** — "Last interval! Give it everything!"
5. **Countdown** — "3... 2... 1... Go!"
6. **Session summary** — "Great workout! 5.2 km in 32 minutes."
7. **Safety alerts** — Spoken error/safety warnings from FFF0 status

### TTS Options

| Engine | Quality | Latency | Cost | Norwegian |
|---|---|---|---|---|
| espeak-ng | Robotic | Instant | Free | Poor |
| OpenAI TTS | Natural | ~1s | $15/1M chars | Good |
| ElevenLabs | Very natural | ~1s | $5/mo starter | Good |
| Google Cloud TTS | Natural | ~500ms | Free tier available | Good |
| Piper (local) | Good | Instant | Free | Some voices |

### Architecture

```
BLE sensor data (speed, HR, segment) 
    → coaching logic (rules engine)
    → TTS API call or local engine
    → WAV/PCM audio
    → PulseAudio → A2DP → treadmill speaker
```

### Requirements for Implementation

- PulseAudio running on RPi with bluetooth module
- A2DP connection maintained during workout
- TTS engine (espeak-ng for MVP, cloud API for production)
- Coaching rules engine in ble-service.js or separate process
- Audio queue to prevent overlapping announcements
- Volume control exposed in view.html

## References

### GitHub Repositories
- [tyge68/fitshow-treadmill](https://github.com/tyge68/fitshow-treadmill) — FFF0 protocol in JavaScript
- [cagnulein/qdomyos-zwift](https://github.com/cagnulein/qdomyos-zwift) — Most comprehensive FITSHOW implementation (C++)
- [hughesjs/FitnessMachine](https://github.com/hughesjs/FitnessMachine) — Flutter FITSHOW app

### Technical Articles
- [Treadmill Telemetry (nv1t)](https://nv1t.github.io/blog/treadmill-telemetry/) — BLE FTMS analysis
- [Hacking Treadmill Bluetooth (Yves Debeer)](https://yvesdebeer.github.io/Treadmill-Bluetooth/)
- [Treadmill Controller Reverse Engineering (elliotmade)](https://elliotmade.com/2020/06/26/treadmill-controller-reverse-engineering/) — UART protocol
- [Gabeshacks: Stop Treadmill Beeping](http://www.gabeshacks.com/2017/02/stop-your-treadmill-from-beeping.html)
