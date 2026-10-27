# ETA

Unofficial integration, not affiliated with ETA. It brings into Gladys an
**ETA** boiler (pellets, logs, wood chips: PE-K, PU, ePE-K, SH, HACK…) with
the **ETAtouch** touch display, through its official **local REST
webservices**, **read only**.

> **Warning: never tested with a real boiler.** This integration was written
> from the official document "ETAtouch RESTful Webservices" 1.2 and the Home
> Assistant integration homeassistant_eta_integration, and tested against the
> recorded answers of a PE-K only. Feedback is welcome.

## What you get

One Gladys device per block of the ETAtouch menu, with the names of the
display, in its language: **ETA Kessel** (boiler), **ETA HK** (heating
circuit), **ETA WW** (hot water), **ETA Sys** (system), **ETA LagerUm.**
(pellet extraction)… depending on your installation.

With **Main values** (the default), about thirty values:

- the states of the boiler, the circuits, the hot water and the extraction
  ("Bereit", "Heizen"…) and the modes shown;
- the temperatures: boiler, boiler setpoint, boiler bottom, flue gas,
  outdoor, flow of the circuits, hot water and its setpoint;
- the boiler pressure (bar), the residual oxygen, the feed (%), the power
  asked (kW);
- the pellets: stock, hopper, consumption in total, since the service, since
  the de-ashing, since the ash box was emptied (kg);
- the counters: full load hours, number of heating runs and ignitions.

With **All values**, every readable value of the menu (several hundred,
inputs and outputs included; the time slots are left out). The first reading
of the menu then takes a few minutes.

Only the values of the devices you **add** are read afterwards, one at a
time, at each refresh.

Temperatures are probes (they do not enter the room averages). The pressure
is in bar or Pa, the hours in hours. kg, %, kW, W, rpm… have no unit in
Gladys (the core offers none for these categories): the unit is in the name,
for example "Zählerstände > Gesamtverbrauch (kg)". kW and kWh are **not**
sent to the Gladys energy dashboard (it would count them as electricity). A
value the boiler does not have now ("xxx", "---") is not published: never a
false 0.

The **ETA errors** device gives: active error (0/1), number of active errors,
last error (block, message, priority, time).

Scene trigger **ETA boiler error**: when a read shows an active error never
seen before. Variables: `message`, `block` (the part of the installation) and
`priority` (as the display shows it). The errors already seen are kept (200
at most, in `/data`): an error that stays or comes back does not fire again,
even after a restart. Never at the very first read (it learns the errors
present).

The badge of each device shows "local", "unreachable" when the ETAtouch does
not answer, and an orange dot when one of its values could not be read at
the last refresh.

## Installation

1. On **meineta.at**, register your ETAtouch and **apply for the LAN
   access** ("LAN-Zugriff").
2. On the boiler's display, in the **system settings**, **turn the LAN
   access on** ("Webservices"). Note the IP address of the display (network
   settings); a fixed address (DHCP reservation) is better.
3. In Gladys, install the ETA integration, enter the **IP address** (the
   port is 8080) and save.
4. Open the **Discovery** tab and add the devices you want.

**Security**: the ETAtouch webservices answer **without any password** to
whoever reaches port 8080 of the display (the manufacturer designed them so).
Keep the boiler on your local network: never forward this port from your
router to the Internet.

## Settings

| Setting               | Role                                                                             |
| --------------------- | -------------------------------------------------------------------------------- |
| IP address            | The address of the display, without a path (`192.168.1.50`, or `…:8080`).        |
| Port                  | 8080.                                                                            |
| Values offered        | "Main values" (about thirty) or "All values" (the whole menu).                   |
| Refresh interval      | 60 s by default (60 to 3600).                                                    |
| Language of the names | For the errors device and the messages; the values' names come from the display. |

The **Test the connection** button reads the boiler once if the interval has
passed since the last read; otherwise it shows the time left and the last
status.

## How the integration spares the boiler

- Reading only (GET requests): nothing is ever written to the boiler, no
  value, no variable set.
- One request at a time, the next one after the answer of the previous one.
- One read per interval, never sooner: neither the button, nor Discovery,
  nor a restart of the integration bring it closer (the time of each read is
  kept in `/data` before its first request). Only a new address or port
  (another ETAtouch) reads at once.
- The menu is read at the first read, then kept in `/data`; Discovery reads
  it again at most every 10 minutes, at the next read. Its reading is
  bounded (2 MB, 800 entries, 10 minutes): past that, what was read is kept
  and the status says so.
- After a failure: new try after 1, 2, 5, 10 then 15 minutes (never less
  than the interval). If the ETAtouch asks to slow down (HTTP 429): a pause
  of 1 minute to 6 hours, kept across a restart.

## Firmware

The webservices exist since system software 1.20.0 of the ETAtouch. API 1.2
(software x.49.0 and later) describes each value (`varinfo`); before, the
integration goes into **reduced mode**: the kind of a value is guessed from
the value itself and its name from the menu, and the connection status says
so.

## Known limits

- Read only: no on/off, no setpoints, no modes, no time slots, no "charge
  the hot water now". A future version could offer some of them, off by
  default.
- The ids of the main values come from a PE-K; another boiler may have
  others (buffer tank, solar…): then choose "All values".
- A value that showed "---" without a unit when the menu was read is not
  offered; run a Discovery again later.
- The name of a value is the display's when the menu was read.

## Troubleshooting

- **"no answer from the ETAtouch"**: check the IP address, that the LAN
  access is on in the display, and that Gladys and the boiler are on the same
  network.
- **"no ETAtouch webservices on this port"**: the port is not 8080, or the
  LAN access is off.
- **"an answer that is not an ETAtouch one"**: the address is another
  device's.
- **"reduced mode"**: update the ETAtouch software to get the exact names
  and kinds.
