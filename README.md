# 3MF Explorer

A fast, searchable index of your 3D model library. Point it at the folders
where you keep your `.3mf`, `.stl` and `.obj` files and it builds a table you
can search as you type - with plate thumbnails, designer and title pulled out
of the files themselves, duplicate detection, tags, batch renaming with undo,
and a round trip through Excel for bulk edits.

It runs on your own computer and opens in your browser. No account, no cloud,
nothing uploaded anywhere.

## What it does

- **Indexes your library.** Every `.3mf`, `.stl` and `.obj` under the folders
  you choose. For 3MF files it reads what is embedded inside the file - title,
  designer, description, license, which slicer made it, layer height, nozzle,
  filament, object and plate counts, and the plate thumbnail. STL and OBJ
  files carry no metadata, so those rows are name, size and geometry only.
- **Finds duplicates two ways.** Byte-identical copies, and - the useful one -
  files with the same geometry even when the files differ (resliced, renamed,
  or exported by a different slicer).
- **Tags** you can add, search, rename and merge.
- **Batch renaming** from patterns like `{designer} - {title}`, with a preview
  first and a History tab that puts everything back.
- **Edits that stick.** Fix a title or designer in the table and it stays
  fixed through rescans, renames and moves.
- **Quarantine** for duplicates you want gone: they are moved to a folder you
  choose, not deleted.
- **Excel export and import.** Export the whole library, fix titles,
  designers and tags in a spreadsheet, import it back.
- **Open in your slicer** straight from the table.
- **Optional pairing with [U1 Print Hub](https://github.com/dlgambill/u1hub)**,
  so "Mark for print" sends files to the Hub.

## Download and run

Grab the file for your system from the Releases page:

| System | File |
|---|---|
| Windows (64-bit) | `3MF-Explorer-Windows-x64.exe` |
| Mac with Apple Silicon (M1 and newer) | `3MF-Explorer-macOS-AppleSilicon` |
| Mac with Intel | `3MF-Explorer-macOS-Intel` |
| Linux (64-bit) | `3MF-Explorer-Linux-x64` |

Put it in a folder of its own and run it. Then open
<http://localhost:7333> in your browser.

The first time it runs, it creates `config.json` next to the program. Your
index (`library.db`) and thumbnails (`.thumb-cache`) are kept there too, so
the whole thing lives in that one folder. To move it, move the folder. To
start over, delete `library.db` and `.thumb-cache`.

A few first-run notes:

- Windows may warn about an unknown publisher. Click More info, then Run anyway.
- On a Mac, right-click the file and choose Open the first time. If macOS
  still refuses, open Terminal in that folder and run
  `xattr -d com.apple.quarantine 3MF-Explorer-macOS-*` and try again.
- On Linux (and from Terminal on a Mac), `chmod +x` the file, then run it.
- Only one copy can run on a port at a time. If it flashes and closes,
  something else already has port 7333 - change `port` in `config.json`.

### Running from source instead

You need Node.js 22.13 or newer (it uses Node's built-in SQLite).

```
npm install
npm start
```

In this case `config.json`, `library.db` and `.thumb-cache` live next to
`server.mjs`. On Windows you can also double-click `explorer.cmd`, which
starts the server and opens the browser for you.

## Setting it up

Everything is set in `config.json`. Edit it with any text editor, save, and
restart 3MF Explorer. (There is no settings screen yet.)

```json
{
  "port": 7333,
  "roots": ["D:\\3D Models", "D:\\Downloads"],
  "quarantine": "D:\\3D Models\\_quarantine",
  "concurrency": 0,
  "geometryMaxMB": 0,
  "openWith": [ ... ],
  "hub": { "url": "http://127.0.0.1:4545", "token": "" }
}
```

- **`roots`** - the folders to index. Everything under them is included. On
  Windows, write backslashes twice (`D:\\Models`) or use forward slashes
  (`D:/Models`). After adding folders, restart and hit **Rescan**.
- **`quarantine`** - where "Move to quarantine" puts files. Leave it empty to
  use a `_quarantine` folder next to the program. It works best on the same
  drive as your library, because moving a file across drives is not a
  simple rename. Folders named `_quarantine` are never indexed.
- **`concurrency`** - how many files to process at once during a scan. `0`
  picks a sensible number for your computer.
- **`geometryMaxMB`** - skip the geometry pass on files bigger than this many
  megabytes. `0` means no limit. Big files still get full metadata and
  byte-level duplicate checks.
- **`port`** - the port the page is served on.

Keep `library.db` on a local drive. Your model folders can be on a network
drive, but SQLite's database file should not be.

### Open in slicer

`openWith` is the list behind the "Open in ..." button. Each entry is a name
and the full path to the slicer's program:

```json
"openWith": [
  { "name": "OrcaSlicer", "exe": "C:\\Program Files\\OrcaSlicer\\orca-slicer.exe", "default": true },
  { "name": "PrusaSlicer", "exe": "C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer.exe" }
]
```

The starter config lists Snapmaker Orca, OrcaSlicer, Bambu Studio and
PrusaSlicer at their usual Windows install locations. Slicers that aren't
installed are simply skipped. The button uses the one marked `"default": true`
if it is installed, otherwise the first one it finds. Only programs listed
here can be launched - the page can never ask it to run anything else.

On a Mac, point `exe` at the program inside the app bundle, for example
`/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer`.

## Using it

### Searching

The search box filters as you type across name, title, designer, description,
path and tags. Words are ANDed together.

```
dragon flexi            both words, anywhere
designer:someone        one field only
ext:3mf dragon          combine them
-keychain               exclude
dupe:geometry           only same-geometry duplicates
tag:printed             only things you tagged
"baby dragon"           exact phrase
```

Press `/` to jump to the search box, `Esc` to clear, `Ctrl+A` to select
everything currently shown. Click column headers to sort. Double-click a
Title, Designer or Tags cell to edit it (with several rows selected, the
edit applies to all of them). Double-click anywhere else on a row to open
the file in your slicer.

### Duplicates

**Byte-identical** is the same file twice - the obvious case.

**Same geometry** means the mesh is identical but the file is not. That is the
same model resliced at a different layer height, or renamed, or exported by a
different slicer. Byte hashing misses all of those. 3MF Explorer hashes the
actual vertex set, independent of ordering, so it catches them.

Selecting duplicates never deletes anything. "Move to quarantine" relocates
them so you can look before you commit.

### Batch renaming

Select rows, type a pattern in the footer, hit **Preview rename**. You get a
before-and-after list and nothing happens until you hit Apply. Every batch is
recorded, and the History tab will put it all back.

| Token | Gives you |
|---|---|
| `{title}` | embedded title, or the filename if the file has none |
| `{designer}` | embedded designer, or `Unknown` |
| `{name}` | current filename without extension |
| `{folder}` | parent folder name |
| `{layer}` `{nozzle}` | `0.2mm`, `0.4mm` |
| `{objects}` `{plates}` | counts |
| `{app}` | slicer that made it |
| `{date}` `{year}` | creation date |
| `{mb}` | file size |
| `{sha8}` `{geom8}` | short hashes, handy for forcing uniqueness |
| `{n}` `{nn}` `{nnn}` | sequence number, zero-padded |

So `{designer} - {title} ({nn})` gives something like
`SomeDesigner - Sunflower Dragon (05).3mf`.

Extensions are kept automatically. If two files would end up with the same
name, the second gets ` (2)`, and the preview marks it so you can see it
happened.

**Clean titles** strips the designer's name, the words you list next to the
button, and a trailing catalog number from the Title field (not the file).
**Titles -> filenames** then renames files to match their titles. Both show a
preview first and both can be undone.

### Tags

Select rows, type in the tag box, press Enter. Tags show up in the filter rail
and are searchable with `tag:whatever`. Click a tag in the detail panel to
remove it. Tags are tied to the file's contents, so renaming or moving a file
keeps them.

### Excel export and import

**Export to Excel** saves the whole library as a spreadsheet. Edit the Title,
Designer and Tags columns, or set the Delete column to `TRUE` for files you
want gone, then **Import from Excel**. Rows are matched by ID, and everything
else in the sheet is there for reference only. Deleted files go to the
Recycle Bin, never a hard delete.

## Pairing with U1 Print Hub (optional)

If you also run [U1 Print Hub](https://github.com/dlgambill/u1hub) on the same
computer, the **Mark for print** button can send files to the Hub's Models tab
as print requests.

1. In the Hub's own `config.json`, find `models.explorerToken`. The Hub
   creates it the first time it starts.
2. Paste that value into 3MF Explorer's `config.json` as `hub.token`. Leave
   `hub.url` as `http://127.0.0.1:4545` unless your Hub uses another port.
3. Restart 3MF Explorer.

Now select files and click **Mark for print**. Each one is tagged `for-print`
here (so you can always filter for them) and shows up as a request in the
Hub's Models tab. The files need to be inside the folder the Hub's Models tab
reads. If the Hub is offline the tag is still added, and clicking again later
resends.

If you don't use the Hub, leave `token` empty and ignore the button.

## Privacy and security

- 3MF Explorer only listens on `127.0.0.1`, so only the computer it runs on
  can open it.
- There are no accounts and no password. Anyone who can reach the page can
  rename, move and delete files in your library. If you ever expose it beyond
  your own computer (a reverse proxy, a tunnel), put a login in front of it
  first, for example Cloudflare Access or a proxy with authentication.
- It never contacts the internet. The only outgoing call is to your U1 Print
  Hub, and only if you set `hub.token`.

## Limits and platform notes

- **The first scan takes a while.** It reads every byte of every file to hash
  it and parses every vertex to build the geometry signature. On a library of
  a hundred gigabytes or more, expect it to run for a good stretch. Every scan
  after that only looks at files that changed, so a rescan takes seconds.
- **Delete (Recycle Bin) and Show in folder are Windows only.** They use the
  Windows Recycle Bin and File Explorer. Everything else - scanning, search,
  duplicates, tags, renaming, quarantine, Excel, Open in slicer - works on
  Mac and Linux too.
- **Long paths are handled on Windows.** Paths longer than 260 characters are
  read through the extended-path form, so deep download folders are not
  silently skipped.
- **Nothing is ever hard-deleted.** Renames are reversible from the History
  tab, duplicate cleanup moves files to quarantine, and Delete uses the
  Recycle Bin.

## Command-line helpers (running from source)

```
node scan-cli.mjs                 rebuild the index for every folder in config.json
node scan-cli.mjs "D:\Downloads"  just one folder
node status.mjs                   quick counts, no server needed
node selftest.mjs "D:\Models"     parser and rename-token sanity check
node verify.mjs "D:\Models"       streamed-parser vs whole-file check
```

Don't run a scan from the command line while the server is scanning too.

## Building the binaries

```
npm install
npm run build
```

This writes all four downloads to `dist/`. `npm run build -- win` (or
`mac-arm`, `mac-intel`, `linux`) builds just one. It bundles the code with
esbuild, then wraps it in a Node 24 runtime with
[@yao-pkg/pkg](https://github.com/yao-pkg/pkg). The first build downloads
the runtimes, so it needs internet access.

The Apple Silicon build has to be signed before it will run on a Mac. Built
on a Mac, that happens automatically. Built on Windows or Linux, sign it on a
Mac afterwards with `codesign --sign - 3MF-Explorer-macOS-AppleSilicon` (an
ad-hoc signature is enough).

## License

MIT - see [LICENSE](LICENSE).
