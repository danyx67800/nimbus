# Nimbus

Nimbus è uno spazio personale self-hosted per **file, chat, chiamate audio/video e condivisione rapida in stile AirDrop**. È pensato per UmbrelOS, ma funziona con un normale Docker Compose o con Node.js 24.

Nessun servizio cloud, nessuna CDN, nessuna telemetria: il browser carica solo asset serviti dalla tua istanza. Il nome, la versione e i riferimenti del progetto sono centralizzati in [`app.config.json`](app.config.json): rinomina lì l'app e rigenera la build.

> **Perimetro di sicurezza, in breve.** File e chat passano dal server e sono cifrati a riposo (AES-256-GCM, chiave per file avvolta dalla master key). Le chiamate WebRTC e i trasferimenti rapidi P2P usano DTLS-SRTP/DTLS DataChannel: quando sono in P2P il server non vede i media. Il relay TURN inoltra pacchetti cifrati, ma vede metadati di rete. Non esiste ancora una cassaforte E2EE lato server per file o chat: chi controlla server e volume può leggere i contenuti. Dettagli in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

## Funzionalità

- **Ricerca globale**: barra in alto e spotlight con scorciatoia `⌘K` / `Ctrl K`, ricerca file e navigazione rapida.
- **Bacheca**: progetti condivisi in stile Trello con membri e ruoli, etichette, scadenze, assegnatari, checklist con progresso e note, allegati e foto di copertina, commenti, drag & drop e chat di gruppo per progetto.
- **File**: cartelle, drag & drop multiplo, upload a chunk riprendibile, download, anteprime (immagini, PDF, video, audio, testo), rinomina, sposta, copia, preferiti, cestino con ripristino, ricerca, versioni.
- **Condivisione**: con altri utenti (lettura/scrittura) e link pubblici con password, scadenza, limite download e revoca.
- **Cifratura a riposo**: AES-256-GCM a chunk da 1 MiB, header versionato, AAD legato a file/versione/indice; chiavi per file avvolte con la master key dell'istanza.
- **Chat**: 1:1, gruppi, canali, WebSocket, cronologia ricercabile, risposte, reazioni, typing, conferme di lettura disattivabili, allegati dai propri file o caricati al volo, notifiche browser/push.
- **Chiamate**: mesh WebRTC fino a 4 partecipanti, audio/video, screen share, mute, cambio dispositivi, qualità adattiva, suoneria, rifiuto/occupato. Credenziali TURN effimere HMAC.
- **Condivisione rapida**: presenza, overlay radar, richiesta con nome/dimensione/tipo/SHA-256, accettazione/rifiuto, timeout 60 s, DataChannel con backpressure e verifica hash, annullamento, fallback cifrato nella chat 1:1.
- **Account**: niente registrazione pubblica; admin crea utenti o inviti monouso; ruoli, quote, pannello admin, sessioni revocabili, audit; Argon2id, TOTP con codici di recupero, passkey WebAuthn opzionali.
- **PWA**: manifest, service worker, offline page, temi chiaro, scuro e nero OLED, interfaccia it/en.

## Requisiti

- Node.js **>= 24** e npm.
- Docker + Docker Compose per l'installazione containerizzata.
- Un browser moderno. **HTTPS o localhost** sono obbligatori per fotocamera/microfono, Service Worker e PWA. Su `http://umbrel.local` il browser non è un secure context: Nimbus mostra un banner e disabilita chiamate/condivisione rapida finché non apri l'istanza in HTTPS.

## Avvio locale (sviluppo)

```bash
cp .env.example .env
npm ci
npm run dev
```

Apri `http://localhost:3000` (oppure il valore di `PORT`). Al primo avvio viene mostrato il wizard per creare l'amministratore. I segreti vengono generati automaticamente in `data/secrets/` con permessi `0600`.

Comandi:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm start
```

## Installazione con Docker Compose

```bash
git clone <il-tuo-repository> nimbus
cd nimbus
cp .env.example .env
# Linux: il container gira come UID/GID 1000
mkdir -p data
sudo chown -R 1000:1000 data
# Facoltativo, per le chiamate fuori dalla LAN:
#   apri .env e imposta TURN_SECRET (openssl rand -hex 32), TURN_HOST,
#   TURN_PORT e, se sei dietro NAT/Docker, TURN_EXTERNAL_IP
docker compose up -d --build
```

Apri `http://<server>:3456` (o la porta scelta in `NIMBUS_PORT`). L'app ascolta internamente sulla 3000 e non richiede privilegi: il container è `read_only`, `cap_drop: ALL`, `no-new-privileges`, con `/tmp` tmpfs e limiti di memoria/CPU.

Per includere coturn:

```bash
# TURN_SECRET è obbligatorio: senza di esso il profilo non parte.
docker compose --profile calls up -d
```

Per includere ClamAV (scansione degli upload; consuma RAM e va inizializzato):

```bash
# In .env: CLAMAV_HOST=clamav
docker compose --profile clamav up -d
```

La prima scansione richiede il download delle firme; finché ClamAV non è pronto gli upload possono risultare in attesa. Non è un antivirus perfetto: è un livello aggiuntivo.

### Variabili principali

| Variabile | Default | Note |
|---|---|---|
| `PORT` | `3000` | Porta interna. |
| `DATA_DIR` | `./data` (`/data` in container) | DB SQLite, file cifrati, segreti, upload temporanei. |
| `TRUST_PROXY` | `true` | Metti `false` se l'app è raggiunta direttamente e non da un reverse proxy. |
| `REQUIRE_HTTPS` | `false` | Metti `true` dietro un proxy TLS: le richieste HTTP ricevono 426. |
| `SECURE_COOKIES` | `auto` | `always` per forzare cookie `Secure`. |
| `EXTRA_ORIGINS` | vuoto | Origini aggiuntive consentite per CSRF/WebSocket, separate da virgola. |
| `TURN_SECRET` | generato nel volume | Deve coincidere con il segreto statico di coturn quando usi il relay. |
| `TURN_HOST` / `TURN_PORT` | vuoto / `3478` | Nome host o IP che i browser usano per raggiungere coturn; genera gli URL `turn:` UDP e TCP. |
| `TURN_URLS` | vuoto | Alternativa esplicita, separata da virgole. |
| `TURN_EXTERNAL_IP` | vuoto | IP che coturn annuncia come relay quando Docker/NAT nasconde l'indirizzo reale (IP LAN, pubblico o Tailscale). |
| `TURN_REALM` | `nimbus` | Deve coincidere con coturn. |
| `RP_ID` | derivato dalla richiesta | WebAuthn relying party ID. Lascialo vuoto per seguire il nome host corrente; impostalo solo per un dominio stabile (sui domini pubblici può essere uguale o suffisso dell'host, su quelli locali deve coincidere). |
| `CLAMAV_HOST` / `CLAMAV_PORT` | vuoto / `3310` | Abilita la scansione. |
| `MAX_UPLOAD_BYTES` | 2 GiB | Limite per upload. |
| `MAX_QUICK_SHARE_BYTES` | 2 GiB | Limite per trasferimento rapido. |
| `DEFAULT_QUOTA_BYTES` | 20 GiB | Quota iniziale dei nuovi utenti. |
| `SETUP_WINDOW_MINUTES` | `60` | Finestra del wizard iniziale. |

I segreti applicativi (master key, chiavi di condivisione/CSRF/recupero, VAPID, TURN) sono creati in `data/secrets/` con permessi `0600`; non vanno mai committati. Se `TURN_SECRET` è impostato, il segreto TURN esterno ha precedenza e deve essere condiviso con coturn.

## HTTPS: perché è obbligatorio

`getUserMedia`, WebAuthn, Service Worker e installazione PWA richiedono un **secure context**. `http://localhost` è considerato sicuro; `http://umbrel.local` e gli IP di LAN no. Nimbus rileva la condizione, mostra un banner e una guida (`/help`) e disabilita le funzioni che richiedono il secure context.

Guida operativa con comandi per Umbrel, Tailscale, Caddy e Cloudflare Tunnel: [`docs/HTTPS.md`](docs/HTTPS.md). Opzioni consigliate, in ordine di semplicità:

1. **UmbrelOS 2.0**: il manifest usa `requiresHttps: true` e `manifestVersion: 2.0`; Umbrel apre l'app in HTTPS. Assicurati che l'installazione Umbrel sia aggiornata e che il certificato del dispositivo sia considerato attendibile dal browser. Se il certificato non è attendibile, WebAuthn/PWA restano limitati: usa Tailscale o un dominio con certificato valido.
2. **Tailscale con HTTPS**: esponi Nimbus solo sulla tailnet e usa un nome MagicDNS con certificato. Esempio con `tailscale serve` sul host che raggiunge la porta 3456. Non pubblicare la porta su Internet se non necessario.
3. **Reverse proxy con certificato** (Caddy, nginx, Traefik): termina TLS sul proxy e inoltra a `127.0.0.1:3456`. Imposta `TRUST_PROXY=true`, `REQUIRE_HTTPS=true`, `SECURE_COOKIES=always` e aggiungi l'origine pubblica a `EXTRA_ORIGINS` se il proxy riscrive Host/Origin.
4. **Cloudflare Tunnel**: comodo per l'accesso remoto, ma Cloudflare termina TLS e vede il traffico applicativo. Non è compatibile con l'idea di "nessun servizio cloud esterno": usalo solo se accetti questo compromesso e documentalo agli utenti.

Con un reverse proxy, mantieni la porta 3000 non pubblicata e limita l'accesso al proxy. Se usi WebAuthn su un dominio pubblico, imposta `RP_ID` sul nome host stabile (non su IP) e non cambiarlo senza riregistrare le passkey; su nomi locali come `umbrel.local` lascialo vuoto.

### PWA

Dopo il primo caricamento in HTTPS, usa "Installa app" dal browser. Il service worker serve la shell e i file statici; le API e i WebSocket restano online-only. Su iOS le notifiche push PWA hanno limiti di piattaforma.

## TURN e chiamate fuori dalla LAN

Le chiamate 1:1 e fino a 4 partecipanti usano WebRTC mesh e, quando possibile, connessioni dirette P2P. Dietro NAT simmetrici o firewall serve un relay TURN:

- `3478/tcp` e `3478/udp`: TURN/STUN.
- `49160-49200/udp`: intervallo relay (modificabile in `docker-compose.yml` e nella configurazione coturn).
- Se il server è dietro NAT, coturn deve conoscere l'IP pubblico (`--external-ip`) e le porte relay devono essere inoltrate. La configurazione fornita è pensata per LAN/Tailscale; per l'esposizione su Internet aggiungi l'IP esterno e regole firewall.

In `.env`:

```dotenv
TURN_SECRET=<openssl rand -hex 32>
TURN_HOST=turn.example.com
TURN_PORT=3478
TURN_EXTERNAL_IP=203.0.113.10
TURN_REALM=nimbus
```

`TURN_HOST` deve essere risolvibile e raggiungibile dai browser di tutti i partecipanti: un nome valido solo in LAN (`umbrel.local`) non funziona da fuori. Con Tailscale usa il nome MagicDNS (`<host>.<tailnet>.ts.net`) o l'IP `100.x.y.z`; in quel caso `TURN_EXTERNAL_IP` deve essere lo stesso IP Tailscale, perché coturn annunci un relay che i client remoti possono raggiungere. Se coturn è dietro NAT, usa l'IP pubblico e inoltra le porte relay. In Docker l'app e coturn stanno su una rete bridge: senza `TURN_EXTERNAL_IP` coturn annuncia l'IP interno del container, irraggiungibile anche dai client in LAN; imposta l'IP del host (LAN, pubblico o Tailscale).

Il backend genera credenziali TURN effimere con HMAC (stile TURN REST API) e le consegna solo a sessioni autenticate. Non usare un segreto statico nel client. Con `TURN_URLS` puoi specificare più URL, ad esempio `turns:` su un reverse proxy TLS; in tal caso configura anche TLS su coturn o sul proxy.

Verifica con la pagina di test Trickle ICE del browser: devono comparire candidati `relay` se il TURN è raggiungibile. Da browser, dopo il login, `await (await fetch('/api/calls/ice')).json()` mostra gli URL `turn:` consegnati ai client: se contengono ancora `umbrel.local`, l'override non è stato applicato. Senza TURN, le chiamate funzionano solo sulla stessa LAN o con NAT favorevoli.

## UmbrelOS

Il pacchetto è in [`umbrel/`](umbrel):

```text
umbrel/
  umbrel-app-store.yml
  nimbus-app/
    umbrel-app.yml
    docker-compose.yml
    exports.sh
    icon.png / icon.svg
    gallery/1.png, 2.png
    data/.gitkeep
```

- Manifest standalone: app ID `nimbus-app`, store ID `nimbus` (l'ID app deve iniziare con l'ID dello store).
- La copia pubblicata nello store **Gigio & Dany** usa l'ID `g-d-app-store-gd-nimbus` e `APP_HOST: g-d-app-store-gd-nimbus_app_1`, perché l'ID dell'app deve iniziare con `g-d-app-store`. Il codice è lo stesso; cambia solo il confezionamento.
- `manifestVersion: 2.0`, `requiresHttps: true`, `storage.dataRoot: data`, `port: 3789`.
- `app_proxy` punta a `nimbus-app_app_1:3000`; `PROXY_AUTH_ADD: "false"` perché Nimbus ha autenticazione multi-utente propria. L'autenticazione Umbrel è single-owner e impedirebbe agli utenti aggiuntivi di accedere. Le route pubbliche dell'app restano protette da token/password e rate limit; tutte le altre richiedono la sessione Nimbus.
- `exports.sh` deriva il segreto TURN per installazione con `derive_entropy`; app e coturn ricevono lo stesso valore. Nessun segreto è nel repository.
- `umbrel-app.yml` espone `TURN_HOST` (servizio `app`) e `TURN_EXTERNAL_IP` (servizio `coturn`) in **Impostazioni → App settings → Nimbus → Advanced → Environment variables**. Sono override applicati al riavvio: non serve modificare il compose né l'immagine. Con Tailscale imposta `TURN_HOST` al nome MagicDNS o all'IP Tailscale e `TURN_EXTERNAL_IP` all'IP Tailscale (`tailscale ip -4`).
- Tutti i dati stanno in `${APP_DATA_DIR}/data`; il container non scrive nel proprio filesystem.

Pubblicazione:

1. Pubblica l'immagine multi-arch (obbligatoria per lo store):

   ```bash
   docker buildx build --platform linux/amd64,linux/arm64 \
     -t ghcr.io/danyx67800/nimbus:1.3.3 --push .
   ```

2. L'immagine è già riferita come `ghcr.io/danyx67800/nimbus:1.3.3` in `umbrel/nimbus-app/docker-compose.yml`.
3. Per generare un pacchetto autonomo:

   ```bash
   UMBREL_ASSET_BASE_URL=https://raw.githubusercontent.com/danyx67800/nimbus/main/umbrel/nimbus-app \
     npm run package:umbrel
   ```

   L'output è `dist/umbrel-store`. L'icona e le gallery PNG sono già incluse; se cambi l'immagine, rigenera i PNG dai sorgenti SVG.

4. Per lo store **Gigio & Dany**, l'app è pubblicata in [`Gigiomiccio425/Gigio-dany-appstore`](https://github.com/Gigiomiccio425/Gigio-dany-appstore) nella cartella `g-d-app-store-gd-nimbus`. Su Umbrel: App Store → menu → Community App Stores → aggiungi l'URL del repository.

Nota: lo store community di Umbrel può non mostrare icone/gallery relative; gli URL raw completi sono la soluzione stabile. Il repository sorgente è [`danyx67800/nimbus`](https://github.com/danyx67800/nimbus).

## Backup e ripristino

Il volume contiene dati e chiavi: un backup senza `secrets/` è inutilizzabile, un backup con `secrets/` è equivalente ai dati in chiaro. Trattalo come materiale sensibile e cifralo sempre.

Procedura consistente (raccomandata):

```bash
cd /percorso/di/nimbus
docker compose stop
sudo tar -C data -czf /tmp/nimbus-data.tar.gz .
# Cifra il backup, ad esempio con age:
age -p -o nimbus-$(date +%F).tar.gz.age /tmp/nimbus-data.tar.gz
shred -u /tmp/nimbus-data.tar.gz 2>/dev/null || rm -f /tmp/nimbus-data.tar.gz
docker compose start
```

Ripristino:

```bash
docker compose down
sudo mv data data.old
sudo mkdir data
sudo tar -C data -xzf /tmp/nimbus-data.tar.gz
sudo chown -R 1000:1000 data
docker compose up -d
```

Verifica login, presenza dei file e anteprime. Non ripristinare un DB SQLite mentre l'app scrive: ferma prima il container. Se devi fare un backup a caldo, usa `sqlite3 data/nimbus.db ".backup /backup/nimbus.db"` e accetta che i file possano cambiare durante la copia; per un ripristino coerente preferisci lo stop.

Su Umbrel, il percorso è `${APP_DATA_DIR}/data` (o `APP_DATA_ROOT` se hai spostato i dati). I backup di Umbrel includono il volume; verifica la procedura di ripristino dell'app nella UI di Umbrel.

## Sicurezza

- Threat model: [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).
- Checklist ASVS L2: [`docs/SECURITY_CHECKLIST.md`](docs/SECURITY_CHECKLIST.md).
- Segnalazioni: [`SECURITY.md`](SECURITY.md).
- Limiti noti: [`docs/LIMITS.md`](docs/LIMITS.md).

Controlli implementati: Argon2id, sessioni server-side con token ruotato, cookie HttpOnly/Secure/SameSite=Strict, CSRF con HMAC e controllo Origin, rate limit e lockout progressivo, TOTP/recovery/passkey, CSP con nonce e senza inline script, HSTS, Permissions-Policy, COOP/CORP, `frame-ancestors 'none'`, `nosniff`, `Content-Disposition`, CSP sandbox per contenuti utente, query parametrizzate, validazione zod, storage UUID-only, sniff MIME dal contenuto, audit senza segreti, container non-root/read-only/cap-drop.

## Struttura del progetto

```text
src/                 backend Fastify + WebSocket + SQLite (node:sqlite)
web/src/             frontend TypeScript senza framework (Web Components/DOM)
web/public/          index, CSS, service worker, offline page
test/                test di auth, file, realtime/quick share, SHA-256
docs/                threat model, checklist ASVS, limiti
umbrel/              manifest e compose per la Community App Store
scripts/             build web, packaging Umbrel, controllo i18n
```

## Test

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

I test coprono: setup/login uniforme, CSRF/Origin, rotazione sessione, lockout, logout globale, header, upload cifrato e download byte-esatti, permessi tra utenti, path traversal/nomi ostili, cartelle/versioni/cestino, quote, link pubblici con password/limite, contenuti HTML mai inline, WebSocket con Origin esterna/non autenticato, quick share P2P online e fallback offline, blocchi, SHA-256 incrementale.

## Limiti noti

Vedi [`docs/LIMITS.md`](docs/LIMITS.md). In sintesi: mesh fino a 4 partecipanti (LiveKit non è implementato), nessuna cifratura E2EE per chat/file lato server, ClamAV opzionale e non infallibile, SQLite su singolo nodo, nessuna federazione/LDAP, notifiche push con limiti di piattaforma, backup manuale (non integrato in Umbrel oltre al volume), nessuna UI di amministrazione per più istanze.

## Licenza

Specifica la licenza scelta prima di pubblicare il repository. Il codice non include asset o branding di Nextcloud; l'ispirazione è solo funzionale.
