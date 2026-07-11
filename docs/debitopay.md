# DebitoPay — Payments API (referência da integração)

> Cópia local da documentação oficial (colada pelo operador em 2026-07-11),
> guardada porque o site da DebitoPay bloqueia fetch automatizado. Se a
> integração falhar de forma inexplicável, confirmar primeiro se esta
> referência ainda bate com a documentação viva no painel.

## Essenciais

- **URL base:** `https://gyqoaningqhurhvdugne.supabase.co/functions/v1`
- **Auth:** `Authorization: Bearer sk_live_…` (ou `sk_sandbox_…`), `Content-Type: application/json`
- **Idempotência:** header opcional `X-Idempotency-Key: <uuid>`
- **Identificadores:** todas as chamadas levam `merchant_id` (UUID, Settings → API) e `wallet_code` (código público de 5 dígitos)
- **Mínimos:** M-Pesa/mKesh 10 MZN · e-Mola 50 MZN · Visa/MC 50 MZN · PayFast 5 ZAR

## Criar pagamento — POST /payment-orchestrator

```json
{
  "action": "process",
  "payment_method": "mpesa | emola | mkesh | visa_mastercard | payfast",
  "merchant_id": "uuid-do-merchant",
  "wallet_code": "12345",
  "amount": 150,
  "currency": "MZN",
  "phone": "+258841234567",          // mobile money
  "return_url": "https://…",          // cartões
  "source": "gateway",
  "source_id": "ORDER_123",           // correlação nossa (não é ecoado no webhook!)
  "customer_name": "João Silva",
  "customer_email": "joao@example.com"
}
```

### Respostas por método

- **M-Pesa — SÍNCRONO.** A chamada HTTP bloqueia até o cliente confirmar o PIN.
  `{ "success": true, "payment_id": "uuid", "status": "success", "transactionId": "DD55JOL0XYT", "reference": "DD55JOL0XYT" }`
  O webhook é apenas notificação; a confirmação já veio na resposta.
- **e-Mola / mKesh — assíncrono.**
  `{ "success": true, "payment_id": "uuid", "status": "pending", "reference": "…", "awaiting_confirmation": true }`
  Confirmação chega pelo webhook `payment.completed`.
- **Visa/Mastercard e PayFast — Hosted Checkout.**
  `{ …, "status": "pending", "checkout_url": "https://debitopay.com/checkout/…" }`
  Redirecionar o cliente; volta ao `return_url` com `?status=success|failed`.
  Confirmação real: webhook.

Telefones aceites: `+258XXXXXXXXX`, `258XXXXXXXXX`, `8XXXXXXXX`.

## Consultar estado — POST /payment-orchestrator

```json
{ "action": "check-status", "payment_id": "uuid-pending-payment" }
```

Resposta: `{ "success": true, "payment": { "id", "status", "provider_reference", "payment_method", "amount", "currency" } }`

Estados: `pending` · `success` · `failed` · `expired`

## Webhooks

- Header de assinatura: **`x-webhook-signature`** — HMAC-SHA256 **hex, sem prefixo**, do corpo cru, com o webhook secret (Settings → Webhooks).
- Retentativas com backoff exponencial até 24 h → tratar como idempotente.
- Responder HTTP 200 em < 5 s.
- Eventos: `payment.completed`, `payment.failed`, `payment.refunded`, `payment.chargeback`.
- **O payload NÃO tem id de evento próprio nem eco de `source_id`** — a correlação
  faz-se pelo `data.payment_id` (o id devolvido na criação).

```json
{
  "event": "payment.completed",
  "data": {
    "payment_id": "uuid-pending-payment",
    "merchant_id": "MERCHANT_UUID",
    "wallet_code": "12345",
    "amount": 150,
    "currency": "MZN",
    "method": "mpesa",
    "reference": "DD55JOL0XYT",
    "paid_at": "2026-04-18T12:02:15Z"
  },
  "timestamp": "2026-04-18T12:02:16Z"
}
```

## Erros

Formato: `{ "success": false, "error": "CÓDIGO" }`

| HTTP | Código | Quando |
|---|---|---|
| 400 | Missing required fields | payment_method / merchant_id / amount em falta |
| 400 | Invalid amount | abaixo do mínimo do método |
| 401 | INVALID_API_KEY | Bearer ausente ou hash não bate |
| 403 | WALLET_DOMAIN_NOT_ALLOWED | Origin difere do allowed_domain |
| 404 | WALLET_CODE_NOT_FOUND | wallet_code inexistente |
| 429 | Rate limit exceeded | > 60 sessões/min por merchant |

## Notas para ESTA integração (wacrm)

- Guardamos o `payment_id` da DebitoPay em `payments.provider_reference`; o
  webhook correlaciona por aí (não há eco de source_id).
- Recorrência automática só existe para Visa/MC (tokenização) — o nosso modelo
  de períodos pré-pagos (N meses por pagamento) encaixa no one-off.
- `/payment-session` só é preciso para checkout embebido no browser; não usamos
  (as nossas chamadas são server-to-server com a secret key).
