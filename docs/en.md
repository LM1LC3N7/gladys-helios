# Helios easyControls for Gladys Assistant

Shows a Helios KWL EC heat recovery ventilation unit with the easyControls
board in Gladys, through its Modbus TCP interface on your local network
(no cloud). Unofficial: not affiliated with Helios. Never tested with a real
device: please report what your unit shows (see "To check" in `TODO.md`).

## Requirements

- A Helios KWL EC unit with the easyControls board (the web interface of
  the unit), software 2.01 or later (Helios requires it for Modbus TCP).
  Units with easyControls 3.0, which speak Modbus RTU only, are not
  supported.
- The unit on your local network, with a fixed IP address (set it in your
  router). Modbus TCP uses port 502 and unit id 180, fixed by Helios.
- Modbus TCP has no password: anyone on your network can read and command
  the unit. Keep it on a trusted network.

## Setup

1. Install the integration from the Gladys store.
2. In its configuration, enter the IP address of the unit and save.
3. Open the Discovery tab and add the unit.

## What Gladys shows

- Outdoor, supply, exhaust and extract air temperatures (°C).
- Operating mode (automatic, manual) and fan stage (1 to 4; stage 0, fans
  stopped, is shown in the status only), fan level (%), supply and extract
  fan speeds (rpm).
- Party mode and standby mode (active or not, minutes left).
- Filter change due, days left before the filter change.
- Fault (any error bit of the unit) and warning; the error code is in the
  status.
- The external humidity (KWL-FTF) and CO2 (KWL-CO2) sensors connected to
  the unit: each one appears once the unit returns a value for it (checked
  at the first read, then every hour), and is kept afterwards.

A value the unit returns empty, as "-" (no sensor), out of its range or
malformed is unknown: it is never published, never as 0.

## Reads

The unit is read every refresh interval (60 s by default, 30 s to 1 h),
over one Modbus TCP connection, one request at a time (each variable is two
requests: its selection, then its read). Reads never come sooner than the
interval after the previous one, including after the "Test the connection"
button, a Discovery scan, a reconnection to Gladys or a restart of the
integration (the time of the last read is kept in `/data`). Reads that come
sooner: a new address saved, the reads of a command (before and after its
write), a party stop and its resends (the read back of the party mode), and
the follow-up reads 5 s and 20 s after a command.

The MAC address of the unit is read first. The first one read is kept for
this address; if another one answers later, its values are not shown, the
commands are refused, and the status says so. "Test the connection" then
accepts the MAC address shown (for a replaced board).

Another Modbus client (Home Assistant, a script) reading the unit at the
same time may change the variable selected between our two requests: the
answer then names another variable and that value stays unknown for this
read.

## Commands

Off by default. With "Allow the commands" on:

- **Operating mode** (automatic, manual).
- **Fan stage** 1 to 4, only in manual mode (in automatic mode the unit sets
  the stage itself: switch to manual first). Stage 0 (fans stopped) is
  never offered.
- **Start the party mode** (with the duration and stage set on the unit).

Each command reads the unit just before (MAC address, standby, fan stage,
operating mode or party mode) and is refused when one of them cannot be
read, when another MAC address answers, in standby mode or with the fans
stopped (stage 0: the command could start them), or when `/data` cannot be
read. A party mode start after a party stop is also refused when `/data`
cannot be written (the stop guard must be lifted there first). It is written within 3.5 s of the click, then read back: success only
when the value read back is the one asked. Otherwise the answer is "sent,
without confirmation" (a check follows 5 s and 20 s later), "refused by the
unit" (Modbus exception 1 to 3), or "not sent".

## Stopping the party mode

"Stop the party mode" never depends on the "Allow the commands" option, on
another command, on the identity check, on a failed read or on the
configuration being read: before the configuration is read, it goes to the
last address kept in `/data`. It takes the connection from any read or
command, and a command not written yet is then refused. The connection is
tried again every 250 ms for 3.5 s after the press.

It can fail in these cases, and the answer says which:

- no address: none in the configuration, or none kept yet in `/data` while
  the configuration cannot be read ("not sent");
- the unit cannot be reached for 3.5 s ("not sent");
- the write left but the unit did not answer, answered something else, or
  the party mode is still read on, or cannot be read back ("sent, without
  confirmation");
- the unit refused the write with a Modbus exception 1 to 3 ("refused by
  the unit");
- another address is saved while it runs, or the integration stops.

After a press, a stop guard is kept in `/data`. While the stop is not seen
applied, a read showing the party mode on sends the stop again (three times
at most per press), and a stop not confirmed is sent again when the
integration starts, before the configuration is read. If a party mode start
from Gladys was written and not confirmed before the stop, the party mode
read on in the 2 minutes after the stop is also taken for that start
landing late, and the stop is sent again (same limit). The guard is not
lifted by the time: only by a party mode start from Gladys (option on), by
the party mode read on two reads in a row after the stop was seen applied
(started on the unit or by another app), or by another address saved.

## Status

The configuration screen shows the state of the unit (stage, mode, party
mode, fault code, filter), the reason of a failure and the time to the next
read. If Gladys cannot give the configuration to the integration, the
status says so and the configuration is asked again after 5 s, 15 s, 30 s,
then every minute.

## Privacy

`/data/helios-state.json` holds the time of the last read, the address and
MAC address of the unit, the external sensors seen and the party stop
guard. Nothing is sent anywhere but to the unit.
