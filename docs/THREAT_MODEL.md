# Threat model — Nimbus

Ultimo aggiornamento: novembre 2026. Riferimento: OWASP ASVS 4.0.3 livello 2, OWASP Top 10 2021, linee guida Umbrel.

## 1. Perimetro e assunzioni

Nimbus è un'applicazione web self-hosted composta da:

- un processo Node.js/Fastify che serve SPA, API REST, WebSocket di signaling/chat e contenuti;
- un database SQLite (WAL) con metadati, utenti, sessioni, audit, messaggi e condivisioni;
- un volume dati con file cifrati, chiavi e segreti;
- opzionalmente coturn (relay TURN) e ClamAV;
- il browser dell'utente, che è il client fidato per la sessione corrente.

Assunzioni:

- L'host e il volume dati sono amministrati dal proprietario dell'istanza. Chi ha accesso root al host può leggere memoria, chiavi e dati: non è un avversario completamente esterno.
- L'istanza è raggiunta tramite HTTPS per le funzioni che richiedono un secure context. Un accesso HTTP è possibile solo in sviluppo su localhost o per scelta esplicita (con limitazioni).
- Gli utenti sono persone invitate dall'amministratore; non esiste registrazione pubblica.
- Il browser è aggiornato e non compromesso. Estensioni malevole o malware locale sono fuori perimetro.
- Il server non è multi-tenant: una singola istanza serve una comunità/ famiglia. Non è progettato per rivendere quote a organizzazioni ostili tra loro.

## 2. Asset

| Asset | Sensibilità | Dove vive |
|---|---|---|
| Contenuto dei file | Alta | Volume, cifrato a riposo |
| Messaggi e allegati chat | Alta | SQLite e volume |
| Password e hash | Critica | SQLite (Argon2id) |
| Master key e chiavi per file | Critica | `data/secrets/` |
| Segreto TURN / VAPID | Alta | `data/secrets/` o ambiente |
| Sessioni e token CSRF | Alta | DB + cookie HttpOnly / header |
| Metadati (nomi, dimensioni, relazioni, IP, audit) | Media | SQLite |
| Media WebRTC e trasferimenti P2P | Alta | Browser ↔ browser; relay TURN cifrato |
| Disponibilità del servizio | Media | Host/container |

## 3. Attori

- **Utente autenticato legittimo**: usa file, chat, chiamate e condivisione rapida.
- **Utente interno malevolo**: ha un account valido e cerca di leggere/scrivere risorse di altri, abusare del signaling, caricare malware o molestare.
- **Visitatore non autenticato**: ha solo un link pubblico o l'invito; prova enumerazione, brute force, path traversal o abuso dei token.
- **Amministratore**: gestisce utenti e quote; è considerato fidato per l'amministrazione, ma non deve poter leggere password o token. Può comunque accedere ai dati tramite il server: è un rischio residuo dichiarato.
- **Attaccante di rete**: intercetta, blocca o reindirizza traffico; prova CSRF, WebSocket hijacking, downgrade, abuso TURN.
- **Attaccante con accesso al volume**: copia il disco o un backup; prova a leggere file e chiavi.
- **Fornitore di infra/terze parti**: reverse proxy, Tailscale, Cloudflare, registry Docker, host Umbrel; è fuori dal controllo dell'app.

## 4. Confini di fiducia

1. **Browser ↔ Nimbus**: attraversa Internet/LAN. TLS obbligatorio per le funzioni sensibili; cookie di sessione; Origin/CSRF; CSP.
2. **Nimbus ↔ volume**: il server ha le chiavi. La cifratura a riposo protegge dal furto del solo volume senza `secrets/`, non da un server compromesso.
3. **Browser ↔ browser (WebRTC)**: DTLS-SRTP per i media e DTLS DataChannel per quick share. Il server fa signaling e non vede il contenuto P2P.
4. **Nimbus ↔ coturn**: segreto condiviso; credenziali TURN effimere.
5. **Nimbus ↔ ClamAV**: socket TCP interno; il scanner non è esposto all'host.
6. **Nimbus ↔ reverse proxy**: `X-Forwarded-*` fidati solo con `TRUST_PROXY=true`; il proxy deve sovrascrivere gli header.
7. **Umbrel app_proxy ↔ Nimbus**: l'app_proxy instrada ma non autentica (`PROXY_AUTH_ADD=false`); l'autenticazione è quella di Nimbus.

## 5. Minacce e mitigazioni

### 5.1 Account takeover

| Minaccia | Mitigazione | Rischio residuo |
|---|---|---|
| Credenziali deboli | Argon2id, almeno 12 caratteri, 2 categorie, blocco password comuni, nessuna registrazione pubblica | L'utente può scegliere una password riutilizzata; niente breach-check online |
| Brute force / credential stuffing | Rate limit per IP/utente, lockout progressivo, risposte uniformi, audit | Attacco distribuito lento; nessun CAPTCHA (scelta privacy) |
| Furto cookie | HttpOnly, Secure, SameSite=Strict, rotazione al login, revoca sessioni, TTL | XSS sul browser o malware locale |
| 2FA assente | TOTP con secret cifrato, codici di recupero monouso, passkey WebAuthn | Utente che non attiva 2FA; perdita del dispositivo |
| Fixation / sessioni vecchie | Token casuale, rotazione, `sessions` server-side, logout globale | Dispositivo lasciato sbloccato |
| Enumerazione utenti | Login con errore generico e timing equalizzato; `/api/users` richiede auth; link pubblici con token casuale | Messaggi di errore di altre API possono rivelare l'esistenza di una risorsa; uniformati dove possibile |

### 5.2 XSS, CSRF, clickjacking

- Rendering del testo con `textContent`/helper DOM; nessun `innerHTML` con dati utente. La CSP usa nonce, `script-src 'self' 'nonce-…'`, niente `unsafe-inline`; `style-src` con nonce/self.
- CSRF: token HMAC legato alla sessione, header `x-csrf-token` per ogni richiesta mutante; eccezioni limitate a login/2FA/WebAuthn/setup/invito/unlock, con controllo Origin. Cookie SameSite=Strict.
- WebSocket: Origin validata prima dell'upgrade e sessione risolta prima di accettare messaggi; limite di payload (128 KiB) e rate per connessione.
- `frame-ancestors 'none'`, `X-Frame-Options: DENY`, COOP/CORP, Permissions-Policy con camera/microfono solo per self.
- Contenuti caricati serviti con `Content-Disposition`, `nosniff`, CSP sandbox e, opzionalmente, origine contenuti separata.

### 5.3 Upload malevoli e file

| Minaccia | Mitigazione |
|---|---|
| Esecuzione di file caricati | I file non vengono mai eseguiti; storage UUID-only, nessun path costruito da input; content-type dal sniffing |
| Path traversal | ID UUID validati; niente nomi come path; normalizzazione e root confinata; test dedicati |
| HTML/SVG attivo | Download con `Content-Disposition: attachment`, `nosniff`, CSP sandbox; anteprime in iframe sandbox; origine contenuti separata opzionale |
| Bombe di decompressione / zip | Nessuna estrazione automatica; limiti di dimensione; ClamAV opzionale |
| Malware | ClamAV opzionale su upload/consegne; nessuna garanzia; l'utente deve usare cautela |
| Quota/DoS | Limiti per upload, quota per utente, rate limit, cleanup upload stale |

### 5.4 Path traversal e accesso a risorse altrui

- Ogni endpoint che accetta un ID verifica che la risorsa appartenga all'utente o che esista una condivisione/permesso esplicito.
- ID non validi e risorse altrui restituiscono lo stesso `404` dove possibile; i test coprono file, cartelle, versioni, link, chat e quick share.
- Le operazioni admin sono separate e richiedono ruolo `admin`.

### 5.5 Enumerazione e abuso delle API

- Rate limit su login, unlock link pubblici, upload, messaggi, signaling e quick share.
- Token pubblici casuali (256 bit) e con scadenza; password link con Argon2id.
- Limiti di download e revoca; audit delle azioni sensibili.
- WebSocket: messaggi massimi 96 KiB applicativi, 600 messaggi/minuto per connessione, Origin e sessione obbligatorie.

### 5.6 Abuso del signaling / chiamate

- Solo utenti autenticati e online; inviti limitati a 3 destinatari per chiamata; timeout di squillo; stato occupato; niente relay verso utenti arbitrari.
- Credenziali TURN effimere HMAC con TTL; il client non riceve mai il segreto statico.
- Rate limit sui messaggi di signaling; chiusura delle chiamate alla disconnessione.
- Minaccia: un utente accettato può inviare SDP/candidate malevoli. Il browser valida SDP; l'impatto è limitato alla chiamata. Non c'è un SFU che possa isolare codec/CPU: mesh fino a 4.

### 5.7 Furto del volume dati o del backup

- File cifrati AES-256-GCM con chiave per file; chiavi avvolte dalla master key; master key in `secrets/` con permessi 600.
- Se il volume viene copiato **senza** `secrets/`, i file non sono leggibili; metadati e hash restano visibili.
- Se il volume include `secrets/`, il furto equivale al contenuto in chiaro. I backup vanno cifrati e conservati separatamente.
- Il DB SQLite contiene metadati, messaggi e hash; non è cifrato a livello di pagina. Valuta full-disk encryption sul host e backup cifrati.

### 5.8 Utente interno malevolo

- Permessi per file/cartelle, condivisioni esplicite, quote, blocchi, segnalazioni.
- Chat: appartenenza alla stanza verificata; reazioni e ricevute limitate; blocco reciproco per quick share.
- Audit delle azioni sensibili; nessun contenuto di file/messaggi nei log.
- Rischio residuo: un utente può caricare contenuti illeciti o malware; ClamAV e segnalazioni sono mitigazioni, non garanzie. L'admin può leggere i dati tramite l'applicazione (per design).

### 5.9 DoS e supply chain

- Limiti di body/upload, rate limit, timeout, payload WS, memoria/CPU container, healthcheck, `read_only`, `cap_drop`.
- Dipendenze con lockfile; `npm audit`/OSV nella pipeline; immagini pinned; niente script di postinstall non verificati.
- Rischio residuo: un attaccante con risorse può saturare rete/CPU; SQLite e un solo processo non scalano orizzontalmente. Non c'è WAF integrato.
- TURN è un servizio di rete: senza quote/limiti può essere abusato. Limita le porte, monitora il traffico e non esporlo più del necessario.

### 5.10 Privacy e terze parti

- Nessuna telemetria, nessuna CDN, font di sistema, asset locali.
- Push web: il browser contatta il push service del produttore (Google/Mozilla/Apple); il payload è cifrato per il dispositivo ma il servizio vede tempi e dimensioni. È un limite del protocollo, documentato.
- TURN/Cloudflare/Tailscale vedono metadati di rete; non il contenuto P2P cifrato. Cloudflare termina TLS e vede il traffico applicativo: non usarlo se il requisito è "nessun intermediario".

## 6. Cosa non è end-to-end

- **Chat e file**: passano dal server. La cifratura a riposo non è E2EE. Un admin o un attaccante sul server può leggere i contenuti quando il server li decifra per servirli.
- **Chiamate P2P**: DTLS-SRTP protegge i media tra i browser; il server fa signaling e vede metadati. Con TURN, il relay vede solo pacchetti cifrati.
- **Quick share P2P**: DataChannel DTLS; il server vede solo la richiesta (nome, dimensione, MIME, SHA-256) e lo stato. Se fallisce, il file viene caricato sul server del mittente, cifrato a riposo, e consegnato in chat: in quel caso non è più E2E.
- **Cassaforte E2EE**: non implementata. Non viene dichiarata come disponibile. Una fase futura potrebbe usare libsodium per cartelle/chat selezionate, con recupero chiavi e trade-off UX da progettare.

## 7. Rischi accettati / fuori perimetro

- Host compromesso, root, hypervisor o accesso fisico con volume e chiavi.
- Browser compromesso, estensioni malevole, keylogger.
- Attacchi di negazione del servizio su larga scala o DDoS di rete.
- Compromissione del registry Docker o della pipeline di build.
- Contenuti illegali caricati da utenti: servono policy organizzative e, se necessario, moderazione/segnalazione alle autorità.
- Multi-tenancy ostile e compliance formale (GDPR/HIPAA) senza configurazione aggiuntiva.

## 8. Verifica

- Test automatici in `test/`: auth, sessioni, CSRF/Origin, lockout, permessi, traversal, quote, link pubblici, header, WebSocket, quick share online/offline, blocchi, SHA-256.
- Smoke test manuale: setup, login, upload, anteprima, admin, chat live, chiamata con media sintetici, quick share P2P e fallback offline.
- Checklist ASVS in [`SECURITY_CHECKLIST.md`](SECURITY_CHECKLIST.md). Non è una certificazione: è una traccia onesta di copertura e lacune.
