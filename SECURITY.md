# Security policy

## Versioni supportate

| Versione | Supporto sicurezza |
|---|---|
| 1.x | Sì, fino a nuova comunicazione |
| Pre-release / fork | Best effort, senza garanzie |

Nimbus è un progetto self-hosted: la sicurezza dell'host, del reverse proxy, del dominio, dei backup e dei dispositivi degli utenti è responsabilità dell'operatore.

## Segnalare una vulnerabilità

**Non aprire una issue pubblica** con dettagli sfruttabili.

Usa una **GitHub Security Advisory privata** sul repository del progetto (Security → Advisories → Report a vulnerability). In alternativa, contatta privatamente il maintainer indicato nel repository. Sostituisci questo paragrafo con un indirizzo di sicurezza reale prima di pubblicare il progetto.

Includi, se possibile:

- versione/commit e configurazione (Umbrel, Docker, reverse proxy, HTTPS/TURN);
- passi di riproduzione minimi e impatto;
- richieste/risposte o screenshot redatti;
- se il problema riguarda un utente, un admin, un link pubblico o un container.

Non includere password, cookie di sessione, chiavi private, contenuti di altri utenti o dati personali non tuoi.

## Cosa consideriamo in perimetro

- Bypass di autenticazione, autorizzazione o CSRF.
- XSS, injection, path traversal, SSRF, RCE.
- Accesso a file, messaggi, versioni, link o sessioni di altri utenti.
- Debolezze nella cifratura a riposo o nella gestione delle chiavi.
- Abuso del signaling WebSocket, delle chiamate o della condivisione rapida.
- Vulnerabilità nelle immagini/container o nella configurazione Compose fornita.
- Esposizione di segreti o dati sensibili nei log.

## Fuori perimetro

- Host compromesso, accesso root, hypervisor, furto del volume **con** `secrets/`.
- Browser compromesso, estensioni, keylogger, malware locale.
- DDoS di rete e saturation attacks senza una mitigazione applicativa ragionevole.
- Configurazioni esplicitamente sconsigliate (HTTP pubblico, `TRUST_PROXY` errato, segreti condivisi, container privilegiati).
- Vulnerabilità di terze parti già note e senza impatto diretto su Nimbus.
- Ingegneria sociale contro gli utenti.

## Divulgazione responsabile

- Conferma di ricezione: best effort, di norma entro 7 giorni.
- Valutazione e piano di fix: di norma entro 30 giorni per problemi ad alta gravità, compatibilmente con il tempo del maintainer.
- Chiediamo di non divulgare pubblicamente prima di un fix o di una data concordata.
- Non c'è un programma di bug bounty retribuito.
- Se il problema è attivamente sfruttato, segnalalo subito e includi "URGENT" nell'oggetto.

## Hardening consigliato

- HTTPS valido, HSTS, `REQUIRE_HTTPS=true` e `SECURE_COOKIES=always` in produzione.
- Backup cifrati e test di ripristino; il backup deve includere `secrets/` per essere ripristinabile, quindi va cifrato e protetto come un segreto.
- Aggiornamenti regolari di Nimbus, Node, coturn e ClamAV; `npm audit --omit=dev`.
- TURN esposto solo se necessario, con firewall e monitoraggio.
- 2FA/passkey per gli admin; quote e principio del minimo privilegio.
- Non usare Cloudflare Tunnel se il requisito è nessun intermediario che termini TLS.
