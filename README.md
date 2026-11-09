# Velox Timeline Studio

Superficie web di montaggio costruita con
[`@techsquidtv/canvas-timeline`](https://github.com/TechSquidTV/Canvas-Timeline).
È un'app React autonoma: modifica un documento timeline. Il render completo è un
tool MCP separato (FFmpeg), non un pulsante nell'editor.

## Confini (importante)

Questo pacchetto **non conosce** Chronon3D e **non conosce** VeloxEditiingg:

- non importa tipi, pacchetti o file da quei progetti;
- non contiene adapter, stub o "ponti" verso il renderer;
- il documento esportato è definito solo in `src/timeline/document.ts`;
- chi vorrà renderizzarlo lo consumerà dall'esterno, senza che nessuno dei due
  lati importi l'altro.

Il relay è solo trasporto e fan-out. Il server MCP gestisce stato editoriale e,
tramite un producer FFmpeg separato, può restituire un frame, un contact sheet o
renderizzare l'intero MP4: `src/timeline` non importa né FFmpeg né il renderer.

```text
editor React (questa app) ──documento JSON──▶ consumatore esterno
        │
        ├──snapshot + expected_revision──▶ relay ──▶ libreria progetti + progetto attivo
        │                                      └── consumatori esterni (SSE)
        │
        └──tool MCP──▶ agenti
                         ├── inspector FFmpeg (frame / contact sheet)
                         └── timeline_render (coda FIFO, MP4 completo)
                             ├── timeline_render_status (progresso / ETA)
                             └── timeline_render_cancel
```

## Home e progetti

La root è la **libreria progetti**: ogni card apre l’editor sul progetto scelto,
mentre il logo Velox nella topbar riporta sempre alla home.

- home: `/`
- editor di un progetto: `/?project=<project_id>`

Non esiste una vista live separata: l'editor è l'unica superficie e pubblica
automaticamente ogni modifica sul relay.

Il relay mantiene un elenco di progetti con revisione indipendente:

```text
GET  /api/projects                     elenco con metadati e conteggi clip
GET  /api/projects/:id                 snapshot completo di un progetto
POST /api/projects/:id                 pubblica con OCC per quel progetto
GET  /api/projects/:id/revisions       storico degli snapshot (max 50)
GET  /api/projects/:id/revisions/:hid  uno snapshot storico completo
GET  /api/timeline                     snapshot attivo (per la home e i consumatori esterni)
GET  /api/assets                       catalogo importato (pubblico)
POST /api/assets                       registra un asset (protetto da token)
GET  /api/events                       SSE dello snapshot attivo
```

All’avvio il relay apre `.data/projects.sqlite` (SQLite in modalità WAL;
ignorato da git). Se il database è vuoto importa una sola volta il legacy
`.data/projects.json`, che resta come backup e non viene più riscritto; se non
esiste nemmeno quello, usa `server/seed-projects.json` con tre progetti
dimostrativi. Le scritture sono transazioni `BEGIN IMMEDIATE` con il controllo
`expected_revision` dentro la stessa transazione: niente file interi riscritti e
nessuna finestra tra check e update. Nella stessa transazione viene inserito
anche lo snapshot in `project_revisions`, così progetto e storico non possono
divergere. L'editor pubblica automaticamente circa 350 ms dopo ogni modifica
committata, quindi non c'è un pulsante Salva; `.mcp/project.json` resta la cache
atomica del singolo processo MCP. Per un deployment multiutente distribuito il
passo successivo è Postgres dietro le stesse API: il confine HTTP e le revisioni
non cambiano.

I media importati non stanno nel database: il DB conserva i metadati e il file
sta sotto `public/media/imported/`. Il relay serve `/media/` dalla stessa
`TIMELINE_MEDIA_ROOT` usata da FFmpeg, quindi i due processi devono condividere
il filesystem. Se il relay è su un’altra macchina, il passo successivo è uno
store oggetti con URL firmati.

Il database si può spostare con `TIMELINE_DB_FILE`; `TIMELINE_PROJECTS_FILE`
indica solo il JSON legacy da importare quando il database è vuoto.

## Avvio locale

Richiede Node 22.5+ per `node:sqlite`. Canvas Timeline dichiara Node >=24,
quindi su Node 22 npm mostra un warning (la build funziona). Consigliato Node
24. Su Node 22 SQLite emette un `ExperimentalWarning`, soppresso dagli script
`npm run live` / `npm run start`.

Per inspector e render completo MCP serve **FFmpeg** nel `PATH` (oppure
`FFMPEG_PATH`).

```bash
npm install

# terminale 1 — relay live (porta 8787)
npm run live

# terminale 2 — editor Vite (porta 5173)
npm run dev
```

- home: <http://127.0.0.1:5173>
- editor demo: <http://127.0.0.1:5173/?project=velox-demo>

## Tempo e frame (zero drift da floating point)

Il documento canonico usa **microsecondi interi**. Ogni coordinata è quindi un
numero razionale esatto con denominatore 1.000.000; le operazioni non accumulano
errori float.

Il documento può dichiarare un frame rate razionale:

```json
"frame_rate": { "numerator": 30000, "denominator": 1001 }
```

L'MCP accetta sia secondi sia **indici di frame**:

- `start_frame`, `duration_frames`, `source_in_frame`;
- `timeline_convert_time` converte frame ↔ microsecondi ↔ secondi;
- la conversione usa aritmetica `BigInt` e non perde frame su NTSC
  (29.97 = 30000/1001). Esempio verificato: 30 frame = 1.001 s esatti;
- `timeline_set_frame_rate` cambia la base senza spostare i clip;
- un documento legacy senza `frame_rate` usa 30/1.

La UI Canvas continua a ricevere tick interi, quindi il confine web non
reintroduce float nel documento.

## MCP

Il server MCP è in `mcp/server.ts`. Non importa Chronon; l'inspector visivo è
in `mcp/render.ts` e viene usato solo dai tool di ispezione.

```bash
npm run mcp                 # server stdio, per Claude/Codex/client MCP
npm run mcp:test            # test end-to-end: editing, conflitti, frame/JPEG, coda render/cancel, OTIO
npm run mcp:test:features   # relay temporaneo: import, auth, storico, restore, compose, render
npm run mcp:typecheck
```

Config locale: `mcp/mcp.config.json`.
Worker remoto: `mcp/mcp.remote.config.json`, sostituendo host pubblico e
percorso assoluto. Il server MCP va eseguito sulla macchina che possiede i media
locali; il relay pubblico serve solo lo stato.

### Tool

| Tool | Funzione |
|---|---|
| `timeline_create_project` | crea e pubblica un progetto (`project_id`, `seed_demo`, `fps_num/fps_den`) |
| `timeline_get_project` | titolo, timebase, riepilogo e documento completo (stato locale) |
| `timeline_load_project` | carica dal relay l'ultima revisione di un progetto e sostituisce lo stato locale (sync multi-agente / dopo conflitto) |
| `timeline_list_assets` | catalogo media statico + importato, con gli ID usati dai clip |
| `timeline_import_asset` | importa un file, FFprobe, SHA-256, poster, proxy opzionale, deduplica e registra sul relay |
| `timeline_list_revisions` | elenca gli ultimi snapshot del progetto |
| `timeline_get_revision` | legge uno snapshot storico completo |
| `timeline_restore_revision` | ripubblica uno snapshot come **nuova** revisione (storia append-only) |
| `timeline_compose` | compone da brief con regole deterministiche e può accodare subito il render |
| `timeline_add_video_clip` | aggiunge un segmento video (secondi o frame) |
| `timeline_add_overlay_clip` | aggiunge un overlay V2 con opacità e blend mode |
| `timeline_add_audio_clip` | aggiunge voiceover / music / SFX |
| `timeline_move_clip` | sposta un clip (`start_s` o `start_frame`) |
| `timeline_trim_clip` | trim di start, durata e source-in |
| `timeline_set_audio_gain` | gain di un clip audio |
| `timeline_remove_clip` | rimuove un clip |
| `timeline_set_duration` | durata della sequenza |
| `timeline_set_frame_rate` | imposta il timebase razionale |
| `timeline_set_title` | titolo mostrato nell'editor e nella libreria progetti |
| `timeline_replace_document` | sostituisce il progetto da JSON |
| `timeline_apply_transaction` | applica una lista di edit come **una sola revisione atomica** |
| `timeline_validate` | validazione strutturale completa |
| `timeline_convert_time` | conversione esatta frame / µs / secondi |
| `timeline_get_frame` | JPEG del frame attivo compositato dall'inspector |
| `timeline_get_contact_sheet` | griglia JPEG di frame campionati (max 16) |
| `timeline_render` | accoda il render MP4 completo (V1 + overlay V2 + mix audio) e restituisce `job_id` |
| `timeline_render_status` | stato, progresso, fps, speed, ETA, output o errore di un job |
| `timeline_render_cancel` | annulla un job in coda o in corso e libera il worker |
| `timeline_export` | JSON puro, senza campi renderer |
| `timeline_export_otio` | export OpenTimelineIO-compatible |
| `timeline_publish` | ripubblica sul relay con controllo revisione |

Risorsa MCP: `timeline://current` (JSON del progetto corrente).

Persistenza: `.mcp/project.json` (ignorato da git). Ogni mutazione valida salva
e pubblica automaticamente sul relay, sull’endpoint del `project_id` corrente; se
il relay è irraggiungibile il tool restituisce `published.ok = false` senza
perdere lo stato locale. `timeline_create_project` accetta `project_id` per
scegliere la card della home che verrà aggiornata.

Per lavorare sullo stesso progetto con più agenti, ogni server MCP deve
chiamare `timeline_load_project` prima di modificare e dopo un conflitto: il
relay è la fonte condivisa, mentre `.mcp/project.json` è solo la copia locale
del processo. Ogni processo MCP concorrente deve puntare a un
`TIMELINE_STATE_FILE` diverso: il file locale è una cache, non un lock
condiviso.

### Revisioni e transazioni

Tutti i tool di scrittura accettano `expected_revision`. Se il progetto è stato
modificato nel frattempo:

1. il server rifiuta l'operazione con `revision_mismatch` / `409`;
2. **nessuno stato locale viene cambiato**;
3. l'agente chiama `timeline_load_project` per sincronizzare la revisione dal relay e riprova.

`timeline_apply_transaction` applica tutte le operazioni su una copia; se una
qualsiasi fallisce, l'intera transazione viene scartata. Anche il relay applica
lo stesso controllo tramite `expected_revision`, così un editor o un worker non
sovrascrive silenziosamente un'altra sessione. L'editor mostra `CONFLICT` se
riceve un 409.

Esempio:

```json
{
  "expected_revision": 14,
  "operations": [
    { "type": "move", "clip_id": "mcp-sfx-2", "start_frame": 210 },
    { "type": "trim", "clip_id": "mcp-vo-body", "duration_frames": 135 }
  ]
}
```

### Feedback visivo

`timeline_get_frame` accetta `frame` oppure `at_s` e restituisce un content block
MCP `image/jpeg` più metadati (frame, µs, clip attivo, asset). Se non c'è video
attivo o il media manca, restituisce un frame sintetico etichettato.

`timeline_get_contact_sheet` accetta `start_frame`, `end_frame`, `step_frames` e
`columns` (1–4). È limitato a 16 frame per non generare payload enormi.

I media sono risolti dal catalogo `src/timeline/assets.ts`: i cinque asset
demo sono statici, quelli importati arrivano da `GET /api/assets` e vengono
mergiati per `id`. Prima di un frame o di un render l’MCP aggiorna il catalogo
dal relay. `TIMELINE_MEDIA_ROOT` può sovrascrivere la directory condivisa da
relay e FFmpeg; `FFMPEG_PATH` e `FFPROBE_PATH` i binari.

### Ingest media

`timeline_import_asset` riceve `source_path`, `name`, `kind`, `poster_at_s` e
`proxy`. Calcola SHA-256 in streaming, interroga FFprobe per durata, stream
audio/video e risoluzione, copia il file in `media/imported/<sha256>.<ext>`,
genera un poster JPEG e, se richiesto, un proxy H.264 960 px. Se lo stesso hash
esiste già, restituisce l’asset esistente senza duplicarlo. Il render finale usa
sempre l’originale; il proxy è solo per la preview.

L’editor e la home caricano il catalogo dinamico con `useAssetCatalog`, quindi
un asset importato da un agente compare senza rebuild. L’import richiede che
MCP e relay condividano `TIMELINE_MEDIA_ROOT`.

### Storico e rollback

Ogni publish inserisce una riga in `project_revisions` nella stessa transazione
del progetto. Il relay conserva le ultime 50 revisioni per progetto.
`timeline_restore_revision` non cancella nulla: legge lo snapshot e lo
ripubblica con `revision = corrente + 1`, quindi il rollback è a sua volta
storico. `expected_revision` resta supportato per non sovrascrivere un altro
writer.

### Compose da brief

`timeline_compose` è volutamente **rule-based**, non generativo: estrae parole
chiave dal brief, ordina i video per corrispondenza, riempie gli slot V1,
aggiunge overlay, voiceover (esplicito o il primo asset voice/narration),
musica e SFX sui tagli. La musica viene divisa in segmenti e abbassata a gain
0,3 sotto la voiceover (ducking deterministico, non sidechain); se manca la
voiceover il ducking non viene applicato. `platform` (`landscape`, `vertical`,
`square`) determina le dimensioni del render quando `render: true`. Il
documento viene validato prima della pubblicazione. Se la durata richiesta
supera la copertura dei media, lascia nero il resto e restituisce un warning
esplicito. Con `render: true` accoda subito l’MP4 composto; altrimenti l’agente
può rifinire la timeline e lanciare `timeline_render` dopo.

### Render completo

`timeline_render` compone l'intero documento in un MP4 con FFmpeg:

- V1: ogni segmento al suo `timeline_start_us`, con source-in e durata esatti;
- V2: overlay con opacità e blend `screen` o `normal`, nell'ordine del documento;
- audio: voiceover, musica, SFX e, se `audio_enabled`, l'audio dei segmenti,
  mixati con gain e ritardi, limiter e uscita AAC 48 kHz stereo.

Default: 1280×720, frame rate razionale del progetto, CRF 18 e
`renders/<project_id>-r<revision>.mp4` (ignorato da git). Parametri:
`output_path`, `width`, `height`, `crf`. Il render è **solo MCP**: l'editor non
ha un pulsante Render, quindi l'agente può creare e produrre il video senza
intervento umano. Richiede FFmpeg locale e i media sotto `TIMELINE_MEDIA_ROOT`
(default `public/`).

La chiamata è **asincrona**: restituisce subito
`{ job_id, status: "queued", output_path, queued_ahead }`. Un solo worker FIFO
esegue i render in ordine, quindi due richieste non competono per la CPU.

```text
timeline_render          → job_id
 timeline_render_status  → queued / running / completed / failed / cancelled
                           percent, fps, speed, ETA, output_path
 timeline_render_cancel  → termina FFmpeg, elimina il parziale, passa al prossimo
```

`timeline_render_status` senza `job_id` elenca gli ultimi job del progetto
corrente (`limit`, `all_projects`). I job sono persistiti in
`.data/render-jobs/` (ignorato da git; ultimi 50, override con
`TIMELINE_RENDER_JOBS_DIR`). L'MP4 viene scritto in
`<output>.part-<job_id>.mp4` e rinominato solo a completamento: un cancel o un
errore non lascia file parziali visibili come render finiti. Se il processo MCP
si riavvia, i job non ancora conclusi vengono marcati `failed`; la coda è
in-process, non un daemon separato.

### OTIO

`timeline_export_otio` produce un `Timeline.1` con:

- tracce `V1` Video, `V2` Overlay, `A1` Voiceover, `A2` Music, `A3` SFX;
- gli overlay conservano opacità e blend mode nei metadata della traccia;
- `RationalTime` a rate 1.000.000, quindi i microsecondi restano esatti;
- metadata `velox` con revisione, frame rate e ID clip.

È solo export: l'import OTIO non è implementato.

## Auth del relay

L’autenticazione è opt-in e protegge **solo le scritture**; letture, catalogo,
storico e SSE restano pubblici in sola lettura. Imposta un token sul relay e
sugli MCP che devono pubblicare:

```bash
TIMELINE_RELAY_TOKEN='cambia-questo-token' npm run live
TIMELINE_RELAY_TOKEN='cambia-questo-token' npm run mcp
```

Le POST devono includere `x-live-token: <token>`; l’editor lo accetta una volta
come `/?project=<id>&token=<token>`, lo salva in `localStorage` e lo rimuove
dall’URL. Senza token le scritture rispondono `401`; l’editor mostra `OFFLINE`.
Il limite predefinito è 120 scritture/minuto per IP+token, configurabile con
`TIMELINE_WRITE_RATE_LIMIT` (`0` disabilita). Il token non sostituisce
`expected_revision`: autentica il writer, l’OCC impedisce le sovrascritture.

## Build e produzione

```bash
npm run start   # build + relay su http://127.0.0.1:8787
```

Il relay serve anche `dist/` (SPA fallback) e `/media/` dalla media root. `PORT`
cambia la porta.

Per l'accesso pubblico è stato usato un quick tunnel Cloudflare:

```bash
./.tools/cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate
```

L'URL `trycloudflare.com` resta valido finché relay e tunnel sono in esecuzione.
L'URL della sessione corrente è scritto in `.tools/public-url.txt` (runtime, non versionato).

## Cosa c'è

- home con libreria progetti, stato live e accesso all’editor;
- timeline canvas con drag, trim, selezione, playhead rosso con readout, zoom e scrollbar;
- anteprima web con video V1, overlay V2 in blend screen e tre lane audio,
  sincronizzata al playhead;
- media reali in `public/media/real`: cinque sorgenti video, due overlay,
  voiceover, musica e SFX, con poster per la libreria progetti;
- export del documento timeline in JSON;
- validazione strutturale prima del download;
- pubblicazione live a ogni modifica committata, non a ogni frame;
- store progetti SQLite con migrazione automatica dal vecchio JSON;
- catalogo media dinamico con ingest FFprobe, SHA-256, poster, proxy opzionale
  e deduplica;
- storico revisioni append-only con restore come nuova revisione;
- composizione rule-based da brief, con validazione e render opzionale;
- auth opzionale sulle scritture, rate limit e token accettato dall’editor;
- render completo MP4 via MCP con V1, overlay V2, mix audio, coda FIFO,
  progresso e cancellazione;
- MCP con revisione ottimistica, transazioni atomiche, tempo a frame razionale,
  ispezione JPEG/contact sheet, coda render e export OTIO;
- test end-to-end locale e remoto.

## Limiti attuali

- l’auth è opt-in: se `TIMELINE_RELAY_TOKEN` non è impostato il relay resta
  scrivibile da chiunque raggiunga l’URL. Il token è globale, non un account per
  utente; per isolamento tra utenti servono room/account e un confine DB;
- SQLite è locale al processo relay: WAL gestisce letture e un writer, non un
  cluster di relay; per multiutente distribuito serve Postgres;
- lo storico conserva 50 snapshot per progetto e non è ancora esposto nella UI;
  il rollback è disponibile via MCP/API;
- `timeline_compose` è deterministico e non capisce il significato del brief:
  usa parole chiave e regole, non un modello generativo;
- l’ingest presume che MCP e relay condividano il filesystem; un relay remoto
  richiede object storage e upload firmati;
- non esiste ancora un tool MCP per cancellare o rinominare l’ID di un progetto;
  la libreria è condivisa sul relay, non isolata per utente;
- l'inspector visivo mostra il singolo segmento video attivo; il compositing
  multi-traccia completo esiste solo come render MP4 via MCP;
- l'editor, dopo un conflitto, richiede un refresh per riallinearsi alla
  revisione più recente; il pulsante `Ricarica` compare accanto allo stato
  `CONFLICT`;
- il render usa FFmpeg locale e non Chronon; la coda è in-process con un solo
  worker, quindi per multiutente o render distribuiti serve un worker esterno;
- i media in `public/media/real` sono asset locali dimostrativi, non footage
  giornalistico; nessun campo renderer entra nel documento.
