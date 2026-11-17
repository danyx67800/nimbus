# HTTPS e secure context

`getUserMedia` (camera/microfono), WebAuthn, Service Worker e installazione PWA richiedono un **secure context**. `http://localhost` è sicuro; `http://umbrel.local`, un IP di LAN e un dominio HTTP non lo sono.

Nimbus rileva la condizione con `window.isSecureContext`, mostra un banner e disabilita chiamate/condivisione rapida. La pagina `/help` contiene la guida breve. Non aggirare il problema con flag del browser: servirebbe solo alla singola macchina e non è una configurazione supportata.

## Variabili da impostare dietro un proxy

```dotenv
TRUST_PROXY=true
REQUIRE_HTTPS=true
SECURE_COOKIES=always
EXTRA_ORIGINS=https://nimbus.example.com
RP_ID=nimbus.example.com
```

- `TRUST_PROXY=true` solo se il proxy sovrascrive `X-Forwarded-Proto` e `X-Forwarded-For`; altrimenti un client può falsificare l'IP.
- `EXTRA_ORIGINS` è necessario se l'`Origin` del browser non coincide con l'host visto da Nimbus. Non usare wildcard.
- `RP_ID` è il nome host stabile delle passkey: cambiarlo invalida le passkey registrate.
- `REQUIRE_HTTPS=true` fa rispondere `426 Upgrade Required` alle richieste HTTP, tranne `/healthz` per il probe locale.

## 1. UmbrelOS 2.0

Il manifest usa `manifestVersion: 2.0` e `requiresHttps: true`: Umbrel espone l'app tramite il proprio proxy HTTPS. Apri l'app dall'icona Umbrel, non forzare `http://umbrel.local:3789`.

Se il browser mostra un avviso di certificato, installa/aggiorna il certificato di Umbrel sul dispositivo o usa un nome con certificato valido (sotto). Un certificato non attendibile non è un secure context affidabile per WebAuthn e PWA.

## 2. Tailscale con HTTPS/MagicDNS

Tailscale è la via più semplice per l'accesso remoto senza aprire porte su Internet. Sul host che esegue Nimbus:

```bash
# Una volta sola: abilita HTTPS/MagicDNS nella console Tailscale.
tailscale up
tailscale status

# Espone la porta 3456 sulla tailnet su HTTPS (Tailscale gestisce il certificato).
tailscale serve --bg --https=443 http://127.0.0.1:3456
tailscale serve status
```

Apri `https://<host>.<tailnet>.ts.net`. Se usi un reverse proxy locale davanti a Nimbus, esponi quello e imposta `TRUST_PROXY=true`; se `tailscale serve` inoltra direttamente alla 3456, Nimbus vede l'origine Tailscale e va aggiunta a `EXTRA_ORIGINS` se l'host pubblico non coincide.

Per TURN su tailnet, imposta `TURN_HOST=<host>.<tailnet>.ts.net`; non pubblicare la porta 3478 su Internet se tutti gli utenti sono nella tailnet. Con `tailscale serve` il traffico applicativo è terminato localmente e Tailscale non decifra il contenuto oltre il trasporto.

## 3. Reverse proxy con certificato (Caddy)

Caddy è il esempio più breve perché ottiene e rinnova i certificati automaticamente. Supponendo che Nimbus ascolti su `127.0.0.1:3456`:

```caddyfile
nimbus.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3456
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Requisiti:

- DNS `A`/`AAAA` del dominio verso il server, porte 80 e 443 raggiungibili per la validazione ACME.
- Firewall: pubblica solo 80/443; la 3456 resta su loopback.
- Imposta `TRUST_PROXY=true`, `REQUIRE_HTTPS=true`, `SECURE_COOKIES=always`, `EXTRA_ORIGINS=https://nimbus.example.com`, `RP_ID=nimbus.example.com`.
- Se il proxy aggiunge header HSTS/CSP, evita duplicati; Nimbus li imposta già. Non rimuovere `X-Forwarded-Proto`.

Nginx/Traefik vanno configurati allo stesso modo: TLS sul proxy, `proxy_set_header X-Forwarded-Proto $scheme`, `X-Forwarded-For $proxy_add_x_forwarded_for`, `Host $host`.

## 4. Cloudflare Tunnel

Cloudflare Tunnel evita di aprire porte, ma **Cloudflare termina TLS** e vede il traffico applicativo. Non è compatibile con il requisito "nessun servizio cloud esterno" se interpretato alla lettera; usalo solo se accetti il compromesso e informa gli utenti.

```bash
cloudflared tunnel login
cloudflared tunnel create nimbus
cloudflared tunnel route dns nimbus nimbus.example.com
cloudflared tunnel run --url http://127.0.0.1:3456 nimbus
```

Poi:

```dotenv
TRUST_PROXY=true
REQUIRE_HTTPS=true
SECURE_COOKIES=always
EXTRA_ORIGINS=https://nimbus.example.com
RP_ID=nimbus.example.com
```

Valuta Cloudflare Access per limitare l'accesso, ma non sostituisce l'autenticazione di Nimbus. Le chiamate WebRTC e il quick share P2P non passano dal tunnel; TURN deve essere raggiungibile direttamente o via tailnet, altrimenti il relay non funziona.

## 5. Verifica

```bash
curl -sSI https://nimbus.example.com/ | sed -n '1,20p'
curl -sS https://nimbus.example.com/healthz
```

Nel browser, dalla console della pagina:

```js
window.isSecureContext            // deve essere true
!!navigator.serviceWorker         // deve essere true
```

Poi verifica:

1. installazione PWA dal menu del browser;
2. richiesta permesso camera/microfono da una chiamata;
3. login, upload, chat, chiamata di prova e quick share;
4. connessione TURN: nella pagina Trickle ICE devono comparire candidati `relay`;
5. assenza di mixed content nella console (nessuna risorsa `http://`).

## Errori comuni

| Sintomo | Causa |
|---|---|
| `getUserMedia` non disponibile | Contesto non sicuro o permessi negati. |
| Cookie di sessione non inviati | `Secure` su HTTP, `SameSite`/proxy, dominio errato. |
| `403 Origin` su WebSocket | `EXTRA_ORIGINS` mancante o proxy che riscrive Host/Origin. |
| WebAuthn fallisce | `RP_ID` diverso dal dominio corrente o certificato non attendibile. |
| Chiamate solo in LAN | TURN non configurato/raggiungibile o porte relay chiuse. |
| Loop di redirect | `REQUIRE_HTTPS=true` ma il proxy invia `X-Forwarded-Proto: http`. |
