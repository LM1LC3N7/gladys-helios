# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).
It ships no third-party code at runtime besides its npm dependency
`@gladysassistant/integration-sdk` (Apache-2.0). Its Modbus client is
written in JavaScript for this integration; the logic below was ported from
the following projects, under their licenses, reproduced here as they
require.

## Helios documentation

The variables, their lengths, ranges and codings, and the framing of the
requests (unit id 180, start address 1, "vXXXXX=value" strings ended by
NUL, two-step reads) follow the Helios document "Funktions- und
Schnittstellenbeschreibung / Functional and interface description —
Modbus Gateway TCP/IP" (print no. 82 269-001/09.17), published by Helios
Ventilatoren GmbH + Co KG on easycontrols.net. No text of it is reproduced.
Helios is a trademark of its owner; this project is not affiliated with it.

## eazyctrl

- Project: https://github.com/baradi09/eazyctrl (version 0.4, commit 7dda21c)
- Used for: the framing of the variable reads and writes over Modbus TCP
  (function 16 then function 3 from address 1, the check of the variable
  name in the answer), ported to JavaScript in `src/modbus/protocol.js`.
- License: BSD 2-Clause

```
Copyright (c) 2019-2020, Bálint Aradi

All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.

    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## homeassistant-easycontrols

- Project: https://github.com/laszlojakab/homeassistant-easycontrols (version
  0.7.0, commit f9c1015)
- Used for: the choice of the variables shown (party and standby modes,
  operating mode, fan stage, filter, errors, warnings and infos), and the
  rule that a fan stage written from outside goes with the manual mode,
  ported to JavaScript in `src/constants.js` and `src/app.js`.
- License: MIT

```
MIT License

Copyright (c) 2022 Laszlo Jakab

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
