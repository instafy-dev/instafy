---
---

`pnpm stack:down`, `controller:stop` and a prebuilt launch stop only the controller and provider this checkout started, by the pid each wrote to its pid file (with the listeners in that pid's process group), and only while that pid is still that service: a process that started after its pid file was written holds a reused pid, possibly another project's controller, and is never stopped. The launcher no longer runs `pkill -f runtime-controller` or looks controllers up with `pgrep`, which stopped every project's controller on the machine, and it never stops a process only because it holds the port. A provider already on the port when the stack starts is used without being recorded as this checkout's, so `stack:down` leaves it running. No package changes.
