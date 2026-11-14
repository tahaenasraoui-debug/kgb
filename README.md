
</p>
<div align="center">

## KGB

**GBA ROMs out of 3DS Virtual Console `.cia` files, packed into DS `.nds` files, all in your browser.**

</div>

Get a GBA ROM out of a Nintendo 3DS Virtual Console `.cia`, pack that ROM into a Nintendo DS `.nds`, or change the icon on a DS file.

Files stay in the browser. Nothing is uploaded.

![KGB screenshot](assets/image.png)

## What you can do

- **CIA to GBA.** Drop a NoCrypto `.cia` from a GBA Virtual Console inject. KGB strips the AGB_FIRM boot preamble and the `.CAA` footer and gives you the `.gba`.
- **GBA to DS.** Pack a `.gba` into a `.nds`. The DS shows a title card. The original ROM is stored inside as `rom.gba`. A DS does not run the GBA game by itself.
- **DS to GBA.** If a GBA ROM is stored in the `.nds`, download it unchanged.
- **Menu icon.** Put a picture on the DS banner (header `+0x68`). It is reduced to 32×32 and 16 colors.
- - **GBA to CIA.** KGB does not build `.cia` files. Use an established injector such as NSUI or vcoven.

Save type, clock, and a few header fields are shown with the file. Offsets and the raw footer are under **Save config and offsets**.

Use files you are allowed to have. Do not share ROMs you do not own.

## Run the site

You need Node.js 22.

```
git clone https://github.com/tahaenasraoui-debug/kgb.git
cd kgb
npm install
npm run dev
```

Open `http://localhost:8080`.

Build:

```
npm run build
npm run typecheck
npm test
```

`npm run build` produces a server build in `.vercel/output`, not a static folder. Preview the production output with `npm run preview:restart` (serves `127.0.0.1:8081`).

## Notes

- Browsers: any recent Chrome, Edge, Firefox, or Safari. `crypto.subtle` needs a secure context; `file://` will show SHA-256 as unavailable.
- Limits: one file at a time up to 256 MiB; up to 20 files queue up. Heavy CIA parsing and NDS packing run in a Web Worker so the UI stays responsive, with Cancel.
- Encrypted CIAs: KGB only reads NoCrypto injects. Rebuild as NoCrypto with vcoven or NSUI (decrypt personal dumps with GodMode9 first). The error panel still shows whatever the tool could read (title ID, product code, ExeFS names).
- GBA size check: licensed cartridges are 4/8/16/32 MiB powers of two. Anything over 32 MiB is flagged as a likely overdump.
- NDS extras: cartridge layout (ARM9/ARM7/FNT/FAT/banners, banner v2/v3 CRCs), per-file extraction (files over 8 MiB are skipped in the browser view), and sequential Download-all.
- Works offline after first load (pure client-side; the only network fetch is `kgb.py` for the Script tab). Files stay in the browser. Nothing is uploaded.
- No accounts, no tracking, no telemetry — that is intentional.

## License

MIT. See [LICENSE](LICENSE).
