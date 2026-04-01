# BPMS Live Translate v8

Versiune simplificată bazată pe ultima versiune care a mers cel mai bine:
- fără moderator
- Admin poate corecta direct textul sursă în română
- retraducere automată pentru toate limbile
- participantul își alege automat limba după telefon
- reconnect automat pe participant

## Deploy
- Build: `npm install`
- Start: `npm start`

## Environment
- `OPENAI_API_KEY`
- opțional `OPENAI_MODEL=gpt-4.1-nano`
- opțional `OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe`


Public participant link is static at /live (same QR for every session).
