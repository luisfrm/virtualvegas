# VirtualVegas

Micro casino virtual para Telegram. Sin servidor: Worker + Durable Objects + D1, todo en Cloudflare.

**Estado: Fases 0, 1 y 2 hechas.** El bot arranca, valida el webhook, registra jugadores, mueve créditos con un ledger auditable y ya se juega una partida completa en un grupo: `/sorteo` abre un lobby, la gente se une apostando, alguien arranca y el pozo se reparte.

| | |
|---|---|
| Fase 0, Cimientos | ✅ Worker con `/webhook` y `/health`, Durable Object por chat, D1 con migraciones, secret token |
| Fase 1, Usuarios y créditos | ✅ Registro implícito, billetera con ledger, `/saldo`, `/bono`, `/rescate`, `/ranking`, i18n es |
| Fase 2, Motor de salas | ✅ Lobby, apuestas, alarmas, reembolsos, máquina de estados, interfaz `GameEngine` y botones |
| Fases 3–6 | ❌ Dados, ruleta y tragamonedas, robustez, enganche y monetización |

El juego que trae la Fase 2 es **`/sorteo`**, un sorteo entre los del lobby. Está ahí como juego de prueba del motor (es lo que pide el criterio de la fase) y porque no necesita turnos: sirve para ver un ciclo entero funcionando en un grupo real. Los juegos de verdad llegan en la Fase 3 sobre la misma interfaz.

## Puesta en marcha

```bash
npm install

# 1. Crear las bases D1 y pegar su id real en wrangler.toml (ahora hay un placeholder)
npx wrangler d1 create virtualvegas-dev
npx wrangler d1 create virtualvegas          # la de producción

# 2. Migraciones
npm run db:migrate:local          # D1 local, para `npm run dev`
npm run db:migrate:remote         # D1 real, antes del primer deploy

# 3. Secretos locales (wrangler dev lee .dev.vars, NO .env)
#    El fichero ya está creado con tu BOT_TOKEN y un WEBHOOK_SECRET generado.
#    Para regenerarlo: BOT_TOKEN=... WEBHOOK_SECRET=... en .dev.vars

# 4. Desarrollo y pruebas
npm run dev
npm test
npm run typecheck
```

### Desplegar

```bash
npx wrangler secret put BOT_TOKEN          # entorno de dev (el del toplevel)
npx wrangler secret put WEBHOOK_SECRET
npx wrangler deploy --env=""               # --env="" evita el aviso de entornos

npx wrangler secret put BOT_TOKEN --env production
npx wrangler secret put WEBHOOK_SECRET --env production
npx wrangler deploy --env production

# Y una sola vez, con el mismo secreto que subiste:
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://<tu-worker>.workers.dev/webhook" \
  -d "secret_token=<WEBHOOK_SECRET>"
```

`/health` en local devuelve `{"ok":true,"environment":"dev"}`. En Telegram, `/ping` responde con el id de la sala y el número de jugadores: si contesta, el camino Worker → Durable Object → D1 está entero.

### Sobre los dos tokens

Hay **una sola variable, `BOT_TOKEN`**, y su valor cambia por entorno. No hace falta un `BOT_DEV_TOKEN`.

El brief habla de "dos bots de BotFather" por otro motivo: **Telegram permite una única URL de webhook por bot**. Si apuntas el webhook de dev al Worker de dev, el de producción deja de recibir updates. Por eso, si quieres dev y prod vivos a la vez, necesitas dos bots; si no, con uno basta (los tests y `wrangler dev` no registran ningún webhook).

## Cómo se garantiza que no haya saldo negativo

D1 no tiene transacciones interactivas, solo `batch()`. La garantía se apoya en cuatro cosas:

1. **`batch()` es una transacción.** Las sentencias corren en orden y sobre la misma conexión.
2. **El débito va guardado:** `UPDATE users SET credits = credits - ? WHERE user_id = ? AND credits >= ?`. Si no llega el saldo, no toca ninguna fila.
3. **El asiento se inserta condicionado al débito:** `INSERT ... SELECT ... WHERE ... AND changes() = 1`. Así es imposible que quede un asiento sin su movimiento o un cobro sin asiento.
4. **Claves de idempotencia deterministas** (`bonus:<user>:<día>`, `initial:<user>`, `rescue:<user>:<ventana>`) con índice UNIQUE. Reintentar un pago no lo duplica; si dos peticiones idénticas corren a la vez, una revienta contra la restricción y su batch entero se revierte.

De ahí sale la invariante que comprueban los tests:

```
users.credits === SUM(transactions.amount)   para todo usuario
users.credits >= 0                           siempre
```

Solo `src/core/wallet.ts` escribe en `users.credits`. `auditLedger()` detecta a cualquiera que se salte esa capa.

## El motor de salas (Fase 2)

El reparto de responsabilidades es lo que hace que añadir un juego no toque el núcleo:

- **La sala** (`rooms/RoomDO.ts`) manda: abre y cierra el lobby, cobra las apuestas, guarda el estado, pinta los mensajes, arma los vencimientos y devuelve el dinero.
- **El juego** (`games/`) solo calcula el siguiente paso. Recibe el estado y devuelve un `GameStep` con el texto, el estado nuevo, los pagos y cuánto hay que esperar. Es casi una función pura, así que se puede probar sin Telegram ni base de datos.
- **El azar** se inyecta (`core/rng.ts`): en producción es `crypto.getRandomValues`, en los tests un generador determinista.

Tres cosas que conviene tener presentes:

1. **El estado de la partida vive en el SQLite del Durable Object**, no en D1. Así el turno no paga latencia de red, no gasta escrituras de D1 y lo secreto (lo que un juego no quiera enseñar) nunca sale de ahí.
2. **Telegram solo deja una alarma por Durable Object.** No se pone una por cada cosa que podría vencer: se guarda el próximo vencimiento y, cuando la alarma suena, la sala mira en qué fase está y actúa. Que la alarma suene *es* el significado de "se cumplió el plazo", así que no se compara con el reloj; `setAlarm` reemplaza la anterior, de modo que nunca queda una alarma vieja de un plazo que ya no existe.
3. **Las apuestas se cobran al unirse**, no al arrancar, y los reembolsos llevan clave `refund:<partida>:<jugador>`. Devolver dos veces es imposible, aunque la alarma se repita o alguien reintente.

Sobre los botones: un teclado inline es **el mismo para todos** los que ven el mensaje, así que no se puede esconder "Empezar" a quien no es el anfitrión. Los botones se enseñan siempre y quien autoriza es la sala. Además, `callback_data` lleva un `nonce` de la partida para que un botón viejo que sigue visible no pueda actuar sobre la partida nueva.

## Decisiones tomadas (y por qué)

1. **Todo el diálogo vive en el DO, no repartido con el Worker.** El brief ponía los comandos globales en el Worker, pero eso obligaba a tener dos instancias de grammY con dos ciclos de `init()` y dos sitios donde mirar. El Worker solo valida, deduplica y enruta; una única ruta de código es mucho más fácil de seguir. Además, el DO por chat serializa de serie todo lo de un grupo, que es justo lo que necesitará el motor de turnos.
2. **El dedupe de `update_id` va en D1, no en KV.** El plan gratuito de KV son 1.000 escrituras al día; con grupos activos se agota en una tarde. La tabla `processed_updates` lleva estado (`processing` → `done`) y, si el procesado falla, se libera para que el reintento de Telegram sirva de algo.
3. **SQL a mano en la capa de dinero, Drizzle para lo demás.** Drizzle genera el esquema y las migraciones y resuelve las consultas de lectura, pero las tres sentencias de las que depende que no aparezca dinero de la nada se leen mejor tal cual. Mezclar las dos cosas a propósito, y solo aquí.
4. **`bot.init()` una vez por instancia del DO.** grammY lanza si procesas un update sin inicializar. Se hace una llamada a `getMe` por sala (no por update) y, si falla, se reintenta en el siguiente update en vez de arrastrar el error.
5. **El rescate es un comando (`/rescate`), no automático.** El brief no aclaraba si "si el saldo baja de 10, se repone" es automático. Con el saldo bajo no puedes apostar, así que el rescate automático se decidirá al escribir la Fase 2, donde se sabe cuándo termina una partida.
6. **Ranking: global por saldo, por grupo por ganancia neta jugada.** Lo segundo filtra `origin = 'game'`, así que bonos y rescates no inflan la tabla. Hasta que existan juegos, el ranking de grupo sale vacío.
7. **La migración a supergrupo se hará con una tabla de mapeo.** Un Durable Object no se puede renombrar; copiar el estado de uno a otro es frágil. Lo previsto (Fase 4) es `chat_id → active_chat_id` en D1 y enrutar siempre por el id activo. Ya está anotado en `src/index.ts`.
8. **`@cloudflare/vitest-plugin`, no `@cloudflare/vitest-pool-workers`.** El segundo está deprecado y renombrado; su API (`defineWorkersConfig`, `fetchMock`) ya no existe en la versión instalada.
9. **Los tests vacían la base a mano.** El plugin nuevo no aisla el almacenamiento por test (no hay opción `isolatedStorage`), así que sin `resetDatabase()` un test hereda el saldo del anterior.
10. **`t()` con escapado de HTML.** Telegram interpreta HTML en los mensajes, así que los nombres de usuario se escapan antes de meterlos en un mensaje.
11. **Los juegos devuelven un paso, no actúan.** `GameStep` (texto, estado, pagos, timeout) mantiene los juegos como funciones casi puras y deja el dinero, los mensajes y la persistencia en un solo sitio, que es donde hay que tener cuidado.
12. **La sala valida que quien pulsa sea participante; el juego valida el turno.** La sala sabe quién está en la partida, pero solo el juego sabe a quién le toca. El juego rechaza con un paso sin texto y un aviso corto, así no repinta nada.
13. **Un lobby cancelado va de `LOBBY` a `IDLE` directamente, no pasando por `FINISHED`.** Encadenar siempre `FINISHED` dejaba la mesa atascada en `LOBBY`: el chat no podía abrir otra partida y el dinero ya se había devuelto. Lo pilló un test.
14. **El comando sin apuesta apuesta el mínimo (1).** Nadie debería perder 20 créditos por olvidarse de escribir el número.

## Verificación

- `npm run typecheck` limpio y `npm test` con **52 tests en verde** (tres ejecuciones seguidas), corriendo en el runtime real de Workers (workerd) con D1 y Durable Objects de verdad. Lo único simulado es la API de Telegram.
- **Dinero:** débitos simultáneos sin saldo negativo, el número exacto de apuestas que caben en un saldo, reintentos idempotentes, bono una vez por día UTC, cooldown del rescate, la invariante `créditos == SUM(ledger)`, la auditoría y el mismo usuario pidiendo el bono desde seis grupos a la vez.
- **Motor de salas:** un sorteo de punta a punta (lobby → unirse apostando → arrancar → reparto → mesa libre), el lobby cancelado que devuelve las apuestas **disparando la alarma de verdad** (`runDurableObjectAlarm`), que la alarma repetida no devuelva el dinero dos veces, que no pueda empezar quien no abrió la partida, que no se arranque con menos del mínimo, que no entre un jugador de más, que no se pueda apostar lo que no se tiene (y que la mesa quede libre), el clic reenviado que no se cobra dos veces, y que **siempre** se conteste al callback (Telegram deja el botón girando si no).
- **Límites de Telegram:** un test comprueba que cada botón que el lobby llega a enviar cabe en los 64 bytes de `callback_data`.
- `wrangler deploy --dry-run` compila y resuelve los tres bindings.
- `wrangler dev` real: `/health` 200, webhook sin secret 403, update reenviado solo una vez (una fila en `processed_updates`), y un `my_chat_member` crea usuario y asiento inicial en el D1 local.
- **Sin verificar: producción.** Falta crear las bases D1 reales, subir los secretos y registrar el webhook. Nada de eso puede hacerlo yo sin tu cuenta de Cloudflare y tu bot.

## Pendiente antes de la Fase 3

- **`sendDice` no es síncrono.** El resultado del dado no vuelve en la respuesta de `sendDice`: llega como un *update nuevo* que entra por el webhook y hay que correlacionar con la apuesta pendiente. El motor ya está preparado para ello (la sala puede guardar un mensaje pendiente en su SQLite), pero hay que implementarlo al escribir los dados.
- La **ruleta rusa** es lo más expuesto del catálogo (violencia + azar). Decisión de producto, no técnica. La alternativa barata es un juego de pasar una bomba, con la misma mecánica de turnos.
- **Falta agrupar las ediciones de mensaje.** Hoy se edita cuando cambia el estado, y con un sorteo eso son pocas veces; los juegos con turnos y un contador en marcha sí pueden chocar con el límite de Telegram (~1 edición por segundo en el mismo mensaje). Si pasa, el sitio para arreglarlo es `applyStep`, en la sala.

Para lo legal y de monetización (Fase 6) el brief ya avisa: créditos sin valor de canje, revisión de los Términos para Desarrolladores y consulta profesional antes de cobrar.
