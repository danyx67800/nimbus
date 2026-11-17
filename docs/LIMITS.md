# Limiti noti

Questo elenco è deliberatamente esplicito: descrive ciò che **non** è stato implementato o verificato, per evitare aspettative superiori al codice.

## Chiamate e media

- Mesh WebRTC fino a **4 partecipanti**. LiveKit/SFU non è implementato: oltre 4 persone non c'è scalabilità né isolamento CPU/rete.
- Le chiamate richiedono un secure context. Su HTTP LAN il browser non concede camera/microfono: la UI lo rileva e disabilita le funzioni.
- Senza TURN configurato, le chiamate funzionano solo in LAN o con NAT favorevoli. Con TURN, la configurazione `--external-ip` e le porte relay dipendono dalla rete dell'operatore.
- Il cambio dispositivi e la qualità adattiva usano le API del browser; non c'è una regia SFU. Codec e simulcast dipendono dal browser.
- Screen share è disponibile solo con media video attivo e supporto del browser.
- Il test automatico/manuale delle chiamate è stato eseguito con **media sintetici** nel browser di preview (canvas + oscillatore). Non è stato testato con webcam/microfono fisici, né attraverso NAT/TURN reali, né su Safari/iOS.

## Condivisione rapida

- È disponibile solo tra utenti della stessa istanza e con entrambi i browser online.
- Il file P2P non passa dal server, ma il server vede nome, dimensione, MIME, SHA-256, mittente, destinatario e stato. Non è un protocollo anonimo.
- Il timeout della richiesta è 60 s; il trasferimento può durare più a lungo. Se il P2P fallisce, il fallback carica il file nello storage del mittente, cifrato a riposo, e lo invia in chat: in quel caso il server vede il contenuto durante upload/download.
- Non c'è ripresa di un trasferimento P2P interrotto: si riparte dal fallback in chat.
- Il salvataggio sul dispositivo del destinatario dipende dal browser (download/blob). Non c'è scrittura automatica in una cartella.
- La scansione ClamAV del fallback è opzionale: se ClamAV non è configurato, il file viene consegnato senza scansione.

## Chat e collaborazione

- Chat e file **non sono E2EE lato server**: la cifratura è a riposo. Chi controlla il processo o le chiavi può leggere i contenuti.
- Non ci sono chiamate di gruppo chat, thread, sondaggi, messaggi vocali, video messaggi o traduzione.
- Le conferme di lettura sono un conteggio aggregato, non una lista nominativa completa.
- Le notifiche push dipendono dal browser e dal push service; su iOS PWA i limiti sono di piattaforma. Non c'è un server push mobile dedicato.
- La ricerca chat è testuale e limitata ai messaggi a cui l'utente ha accesso; non c'è ricerca full-text esterna.
- Non c'è moderazione automatica dei contenuti; le segnalazioni sono gestite dall'admin.

## File

- Anteprime native per immagini, PDF, video/audio e testo; formati Office/archivi non hanno anteprima o editing.
- Nessuna estrazione automatica di archivi, nessuna conversione/transcodifica, nessuna generazione di thumbnail via FFmpeg.
- La cifratura a riposo protegge il volume senza `secrets/`; non protegge da un server compromesso o da un admin che usa l'app.
- La master key non ha rotazione automatica né procedura di rekey assistita. Per ruotarla servirebbe una migrazione delle chiavi per file.
- Il cestino e le versioni occupano spazio nella quota; non c'è retention automatica configurabile.
- Il download di un file molto grande avviene in streaming, ma il browser potrebbe comunque bufferizzare.
- I file caricati non vengono mai eseguiti; non c'è un visualizzatore sandboxato universale per HTML/SVG (vengono serviti come download/anteprima limitata).

## Account e amministrazione

- Nessuna registrazione pubblica, nessun recupero password via email. Il reset è admin-only e revoca le sessioni.
- TOTP e passkey sono opzionali; non è possibile obbligarli per ruolo nella UI attuale.
- La 2FA non è richiesta per ogni operazione sensibile (solo al login).
- Il pannello admin non gestisce più istanze, cluster, log esterni o backup automatici.
- L'audit è nel DB locale e non è tamper-proof: un amministratore con accesso al filesystem può modificarlo.
- Non c'è SCIM/LDAP/OIDC/SAML; gli utenti sono locali.
- Non c'è blocco geografico, CAPTCHA o protezione bot di terze parti (scelta privacy).

## Infrastruttura e scalabilità

- SQLite WAL e un processo Node: nessuna scalabilità orizzontale, nessun failover. Per più replica servirebbe un DB condiviso e un adapter realtime.
- Le sessioni, il rate limiter e i lockout sono in memoria/DB locale; un riavvio azzera i contatori in memoria.
- Non c'è supporto ufficiale a Kubernetes, Nomad o deploy multi-nodo.
- Il container è pensato per un singolo host; non è testato con rootless Docker, Podman o Windows.
- L'immagine Docker è multi-stage e non-root, ma la build è stata verificata solo sull'architettura della macchina di sviluppo; la pubblicazione multi-arch va fatta con `buildx` e testata su Umbrel reale.
- Il manifest Umbrel è stato scritto secondo la documentazione 2.0, ma **non è stato installato su un dispositivo Umbrel** in questa sessione. Icona/gallery e URL raw vanno verificati nello store reale.

## Sicurezza e privacy

- TLS è responsabilità di Umbrel/reverse proxy. L'app può richiedere HTTPS e forzare cookie Secure, ma non gestisce certificati.
- Non c'è E2EE per chat/file; non c'è cassaforte libsodium. Non viene dichiarata.
- ClamAV è opzionale, può essere lento e non è una garanzia contro malware.
- Il push service del browser è un terzo esterno: vede tempi e dimensioni, non il contenuto cifrato.
- Cloudflare Tunnel/Tailscale sono intermediari: Tailscale non termina il TLS applicativo, Cloudflare sì. La scelta è dell'operatore.
- Non c'è un WAF, SIEM, IDS o monitoraggio centralizzato. Audit e log sono locali.
- Non è stata eseguita una revisione di sicurezza indipendente né un penetration test formale. La checklist ASVS è un'autovalutazione.

## Test non eseguiti

- Installazione reale su UmbrelOS e aggiornamento da una versione precedente.
- `docker compose up` completo con coturn e ClamAV su host Linux (la build dell'immagine è stata eseguita; i profili opzionali no).
- Chiamate con dispositivi fisici, Safari/iOS, NAT simmetrico e TURN pubblico.
- Backup/restore su un volume grande e con WAL attivo.
- Test di carico, soak test, fault injection e disaster recovery.
- Penetration test, SAST/DAST in CI, OSV scanning automatico.
- Accessibilità con screen reader reali (sono presenti label, focus e contrasto di base, ma non è stata fatta una certificazione WCAG).

Se uno di questi punti è un requisito per il tuo deployment, trattalo come lavoro aggiuntivo da pianificare e verificare, non come una funzionalità già garantita.
