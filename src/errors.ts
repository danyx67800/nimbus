export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly expose: boolean;
  retryAfter?: number;

  constructor(statusCode: number, code: string, message: string, expose = true) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.expose = expose;
  }

  withRetryAfter(seconds: number): this {
    this.retryAfter = seconds;
    return this;
  }
}

export const badRequest = (message = 'Richiesta non valida', code = 'bad_request'): HttpError =>
  new HttpError(400, code, message);

export const unauthorized = (message = 'Autenticazione richiesta'): HttpError =>
  new HttpError(401, 'unauthorized', message);

export const forbidden = (message = 'Operazione non consentita'): HttpError => new HttpError(403, 'forbidden', message);

export const notFound = (message = 'Risorsa non trovata'): HttpError => new HttpError(404, 'not_found', message);

export const conflict = (message = 'Conflitto con lo stato attuale', code = 'conflict'): HttpError =>
  new HttpError(409, code, message);

export const payloadTooLarge = (message = 'Contenuto troppo grande'): HttpError =>
  new HttpError(413, 'payload_too_large', message);

export const tooManyRequests = (message = 'Troppi tentativi. Riprova più tardi.', retryAfter = 60): HttpError =>
  new HttpError(429, 'rate_limited', message).withRetryAfter(retryAfter);

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}
