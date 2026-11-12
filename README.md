# KGB

Get a GBA ROM out of a Nintendo 3DS Virtual Console `.cia`, pack that ROM into a Nintendo DS `.nds`, or change the icon on a DS file.

Files stay in the browser. Nothing is uploaded.

## What you can do

- **CIA to GBA.** Drop a NoCrypto `.cia` from a GBA Virtual Console inject. KGB strips the AGB_FIRM boot preamble and the `.CAA` footer and gives you the `.gba`.
- **GBA to DS.** Pack a `.gba` into a `.nds`. The DS shows a title card. The original ROM is stored inside as `rom.gba`. A DS does not run the GBA game by itself.
- **DS to GBA.** If a GBA ROM is stored in the `.nds`, download it unchanged.
- **Menu icon.** Put a picture on the DS banner (header `+0x68`). It is reduced to 32×32 and 16 colors.

Save type, clock, and a few header fields are shown with the file. Offsets and the raw footer are under **Save config and offsets**.

Use files you are allowed to have. Do not share ROMs you do not own.

## Run the site

You need Node.js 22.

```bash
npm install
npm run dev
```

Open `http://localhost:8080`.

```bash
npm run typecheck
npm test
node --experimental-strip-types --test src/lib/kgb/kgb.test.ts
npm run build
```

## Python, for a CIA only

`public/kgb.py` is the same CIA extraction, with the Python 3 standard library only. DS packing stays in the browser.

```bash
python3 public/kgb.py game.cia -o ./out
python3 public/kgb.py game.cia --trim-ff
python3 public/kgb.py --self-test
```

That writes the `.gba`, a `.png` of the icon when one is present, and a JSON file for the footer.

## Put it on GitHub

GitHub stores the code. It does not run this site by itself.

1. On GitHub, choose **New repository**. Name it `kgb`. Leave “Add a README” off, because this file is already here.
2. On your computer, in this project folder:

```bash
git init
git add .
git commit -m "Add KGB"
git branch -M main
git remote add origin https://github.com/YOUR_NAME/kgb.git
git push -u origin main
```

`node_modules` is ignored. Run `npm install` again after a clone.

To put the site on the internet, import that GitHub repo in [Vercel](https://vercel.com). The repo already has `vercel.json`. The build command is `npm run build`.
