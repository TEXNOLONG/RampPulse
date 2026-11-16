# Голосовые звонки через TURN

RampPulse выдаёт TURN-реквизиты только вошедшему пользователю. Сервер создаёт временное
имя вида `время_истечения:id_пользователя` и пароль HMAC-SHA1; общий секрет остаётся только
на RampPulse и coturn. Это схема временных учётных данных coturn REST API.

## RampPulse

Добавьте в `/etc/ramppulse-rust.env` адреса TURN и тот же секрет, который задан в coturn:

```ini
STUN_URLS=stun:stun.l.google.com:19302
TURN_URLS=turn:ВАШ_IP_ИЛИ_ДОМЕН:3478?transport=udp,turn:ВАШ_IP_ИЛИ_ДОМЕН:3478?transport=tcp
TURN_SHARED_SECRET=длинный_случайный_секрет
```

После изменения перезапустите `ramppulse-rust`. Для TURN по TLS используйте отдельный URL
`turns:...` и настройте сертификат на coturn. Секрет не добавляйте во frontend, репозиторий
или публичные логи.

## Coturn

Включите REST-авторизацию coturn с тем же секретом (`use-auth-secret` и
`static-auth-secret`). Откройте на VPS порт 3478 для UDP и TCP, а также UDP relay диапазон,
настроенный параметрами coturn `min-port`/`max-port`. Убедитесь, что этот диапазон разрешён
и в панели firewall хостинга. После этого звонки сначала пробуют прямое соединение, затем
TURN relay при необходимости.

Сервер генерирует временные реквизиты по схеме из [официальной документации coturn](https://github.com/coturn/coturn/blob/master/README.turnserver).
Клиент передаёт список ICE-серверов в `RTCPeerConnection`, согласно [документации WebRTC](https://webrtc.org/getting-started/peer-connections).
