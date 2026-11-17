# Checklist OWASP ASVS 4.0.3 — livello 2

Stato: **traccia di autovalutazione**, non una certificazione. Legenda: ✅ implementato e verificato; 🟡 parziale o con limite documentato; ⬜ non applicabile al modello self-hosted; ❌ non implementato.

## V1 — Architettura, design e threat modeling

| Controllo | Stato | Note |
|---|---|---|
| Threat model documentato | ✅ | `docs/THREAT_MODEL.md` |
| Separazione componenti e confini | ✅ | App, SQLite/volume, coturn, ClamAV opzionale |
| Meccanismi di sicurezza centralizzati | ✅ | Hook Fastify, helper auth/permessi, `withTransaction` |
| Nessun servizio cloud/CDN obbligatorio | ✅ | Asset locali, font di sistema |
| Segreti fuori dal codice | ✅ | `data/secrets/` 0600 o env |
| Dipendenze e lockfile | ✅ | `package-lock.json`; audit da eseguire in CI |

## V2 — Autenticazione

| Controllo | Stato | Note |
|---|---|---|
| Password >= 12 caratteri, complessità, blocklist | ✅ | `src/auth/passwords.ts` |
| Argon2id con parametri moderni | ✅ | 64 MiB, 3 iterazioni, 1 lane |
| Risposte uniformi contro enumerazione | ✅ | Login e dummy hash timing |
| Rate limit e lockout progressivo | ✅ | Per IP e utente, reset su successo |
| 2FA TOTP | ✅ | Secret cifrato, recovery monouso |
| Passkey WebAuthn | ✅ | Opzionale, discoverable |
| Nessuna registrazione pubblica | ✅ | Solo admin/inviti |
| Recupero password via email | ❌ | Non c'è email; reset admin con audit |
| Verifica password compromesse online | ❌ | Scelta privacy; nessuna chiamata esterna |

## V3 — Gestione delle sessioni

| Controllo | Stato | Note |
|---|---|---|
| Token casuale CSPRNG, non nel URL | ✅ | Cookie HttpOnly |
| Rotazione al login | ✅ | Vecchia sessione revocata |
| Scadenza e revoca per dispositivo | ✅ | Pannello impostazioni/admin |
| Logout globale | ✅ | Revoca tutte le sessioni |
| Cookie Secure/HttpOnly/SameSite=Strict | ✅ | `Secure` automatico su HTTPS/localhost, `always` disponibile |
| Timeout di inattività | 🟡 | TTL assoluto e `lastSeen`; non c'è idle timeout separato |
| Protezione da session fixation | ✅ | Nuovo token ad ogni login |
| Sessioni admin separate | 🟡 | Stesso meccanismo, ruolo verificato ad ogni endpoint |

## V4 — Controllo degli accessi

| Controllo | Stato | Note |
|---|---|---|
| Autorizzazione server-side su ogni endpoint | ✅ | `requireAuth`, `requireAdmin`, permessi file/chat |
| Negazione accesso a risorse altrui | ✅ | Test dedicati; 404 uniforme dove possibile |
| Ruoli admin/utente | ✅ | Pannello admin separato |
| Quote e limiti per utente | ✅ | Upload e quota |
| Blocchi e segnalazioni | ✅ | Quick share e chat |
| IDOR su versioni/condivisioni/link | ✅ | Verifica ownership/permesso |
| Admin può leggere i dati | 🟡 | Per design; documentato nel threat model |

## V5 — Validazione, sanitizzazione e encoding

| Controllo | Stato | Note |
|---|---|---|
| Schemi zod su input | ✅ | Route e query |
| Query SQL parametrizzate | ✅ | `node:sqlite` prepared statements |
| Nessun path da input | ✅ | Storage UUID-only |
| Sanitizzazione nomi file | ✅ | NFKC, control/bidi/path strip, lunghezza |
| MIME dal contenuto | ✅ | `sniffContent` |
| Output HTML con textContent | ✅ | Helper DOM; nessun HTML utente |
| CSP con nonce, no inline | ✅ | `src/http/security.ts` |
| CSRF su richieste mutanti | ✅ | HMAC legato alla sessione + Origin |
| WebSocket Origin/auth | ✅ | Prima dell'upgrade e prima dei messaggi |
| Limiti dimensione body/upload/WS | ✅ | Fastify + hub |

## V6 — Crittografia

| Controllo | Stato | Note |
|---|---|---|
| TLS esterno | 🟡 | Responsabilità del reverse proxy/Umbrel; `REQUIRE_HTTPS` disponibile |
| Cifratura file a riposo | ✅ | AES-256-GCM, chunk 1 MiB, AAD |
| Chiavi per file avvolte | ✅ | Master key in secrets |
| CSPRNG per token | ✅ | `crypto.randomBytes`/`getRandomValues` |
| Confronti a tempo costante | ✅ | Sessioni, HMAC, TOTP |
| Hash password Argon2id | ✅ | `hash-wasm` |
| Gestione IV/nonce | ✅ | Nonce casuale per frame, nessun riuso |
| Rotazione chiavi | 🟡 | Non c'è rotazione automatica della master key; richiede procedura manuale |
| Cifratura DB | ❌ | SQLite non cifrato; full-disk encryption consigliata |

## V7 — Error handling e logging

| Controllo | Stato | Note |
|---|---|---|
| Errori generici al client | ✅ | `HttpError`, messaggi controllati |
| Nessun stack trace in produzione | ✅ | Fastify error handler |
| Audit eventi sensibili | ✅ | Login, admin, condivisioni, link, quick share |
| Nessun segreto/contenuto nei log | ✅ | Audit senza password/token/contenuti |
| Log strutturati | ✅ | JSON, livello configurabile |
| Integrità/tamper-proof dell'audit | 🟡 | DB locale; un admin con accesso al DB può alterarlo |
| Monitoraggio/alerting | ❌ | Nessuna integrazione SIEM |

## V8 — Protezione dei dati

| Controllo | Stato | Note |
|---|---|---|
| Classificazione dati | ✅ | Threat model |
| Minimizzazione | ✅ | Solo metadati necessari |
| Cache-Control su dati privati | ✅ | API private `no-store`; shell `no-store` |
| Backup cifrato documentato | ✅ | README |
| Cancellazione/retention | 🟡 | Cestino e purge; nessuna retention automatica configurabile |
| Data export | ❌ | Non implementato |
| Push payload | 🟡 | Cifrato dal push service, ma il provider vede tempi/dimensioni |

## V9 — Comunicazione

| Controllo | Stato | Note |
|---|---|---|
| HTTPS per funzioni sensibili | 🟡 | Richiede proxy/Umbrel; l'app rileva e limita |
| HSTS | ✅ | Solo su HTTPS |
| Certificati validi | 🟡 | Responsabilità dell'operatore |
| TURN effimero | ✅ | HMAC con TTL |
| Media DTLS-SRTP | ✅ | WebRTC |
| DataChannel DTLS | ✅ | Quick share |
| Certificati pinning | ⬜ | Non applicabile a un'app browser self-hosted |

## V10 — Codice malevolo

| Controllo | Stato | Note |
|---|---|---|
| Upload non eseguiti | ✅ | Storage dati, no CGI |
| Content-Type dal contenuto | ✅ | Sniffing |
| CSP sandbox per contenuti | ✅ | Download/anteprime |
| ClamAV | 🟡 | Opzionale, non infallibile |
| Subresource Integrity | ⬜ | Asset locali, nessuna CDN |
| Firma degli upload | ❌ | Non richiesta; SHA-256 solo integrità del trasferimento |

## V11 — Logica di business

| Controllo | Stato | Note |
|---|---|---|
| Flusso quick share con timeout/annullamento | ✅ | 60 s, stati espliciti, fallback |
| Limiti di download link | ✅ | Conteggio e revoca |
| Quote | ✅ | Controllo server-side |
| Inviti monouso con scadenza | ✅ | Revoca e audit |
| Anti-abuso quick share | ✅ | Blocchi, rate limit, stessa istanza, dimensione |
| Idempotenza/retry upload | ✅ | Chunk e resume |
| Race condition su quota/versioni | 🟡 | Transazioni SQLite; test parziali |

## V12 — File e risorse

| Controllo | Stato | Note |
|---|---|---|
| Path confinati | ✅ | UUID-only, nessun path utente |
| Upload con limiti | ✅ | Dimensione, quota, chunk |
| Download con header sicuri | ✅ | `Content-Disposition`, `nosniff`, CSP sandbox |
| Anteprime | ✅ | Testo/immagini/PDF/video/audio; iframe sandbox |
| Virus scanning | 🟡 | ClamAV opzionale |
| File temporanei | ✅ | Cleanup upload stale |
| Range request | ✅ | Decifratura per range |
| Versioni | ✅ | Upload/restore con audit |

## V13 — API e WebSocket

| Controllo | Stato | Note |
|---|---|---|
| Autenticazione API | ✅ | Cookie di sessione |
| Validazione params/body/query | ✅ | zod |
| Rate limit | ✅ | Limiter in memoria |
| Limiti payload | ✅ | Fastify + WS |
| WebSocket autenticato e Origin | ✅ | Test dedicati |
| Errori API coerenti | ✅ | `{error, message}` |
| Documentazione OpenAPI | ❌ | Non richiesta; route documentate nel codice |

## V14 — Configurazione

| Controllo | Stato | Note |
|---|---|---|
| Config via env, segreti separati | ✅ | `src/config.ts`, `secrets.ts` |
| Debug disabilitato in produzione | ✅ | Log level, error handler |
| Header di sicurezza | ✅ | CSP, HSTS, Referrer-Policy, Permissions-Policy, COOP/CORP |
| Container non-root/read-only/cap-drop | ✅ | Dockerfile + compose |
| Healthcheck | ✅ | `/healthz` |
| Dependency audit | 🟡 | Comando disponibile; va eseguito in CI |
| Hardening host | 🟡 | Responsabilità dell'operatore |
| Backend senza eval | ✅ | Nessun `eval`/`Function` |
| Errori di configurazione fail-fast | 🟡 | Alcuni default permissivi (`TRUST_PROXY=true`); documentati |

## Lacune prioritarie

1. Backup/restore automatizzato e testato su Umbrel.
2. Rotazione della master key e procedura di rekey.
3. Cifratura E2EE opzionale per chat/cartelle selezionate.
4. Idle timeout e gestione sessioni più granulare.
5. Integrazione CI con `npm audit`, OSV e test di container.
6. Monitoraggio/alerting e retention configurabile.
7. SFU LiveKit per chiamate oltre 4 partecipanti.

Queste lacune sono note e non vengono presentate come funzionalità esistenti.
