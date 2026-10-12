## Contexto

**VirtualVegas** es un micro casino virtual dentro de Telegram, gratuito y de ocio. Cada grupo es una sala donde se lanzan juegos con comandos (`/tragamonedas`, `/dados`, `/ruleta`) y se juega con botones inline. Los jugadores tienen un saldo de créditos global que ganan y pierden jugando. Si el juego engancha, más adelante se venderán créditos, por eso el sistema se diseña desde ahora como si fuera dinero: auditable, atómico y sin saldos negativos.

**No hace falta ningún servidor.** Todo corre en Cloudflare, sin VPS ni procesos que mantener encendidos:

```
Telegram ──POST /webhook──▶ WORKER                       ← sin estado
                              • valida el secret token
                              • registra/actualiza al usuario (D1)
                              • atiende comandos globales (/saldo, /bono, /ranking)
                              • enruta lo de juegos por chat_id
                                    │
                                    ▼
                           DURABLE OBJECT "RoomDO"        ← uno por grupo, con estado
                              • estado y reglas de la partida
                              • turnos y timeouts (alarms)
                              • edita mensajes y mueve créditos
                                    │
                         ┌──────────┴──────────┐
                         ▼                     ▼
                  D1 (usuarios, ledger)   api.telegram.org (fetch)
```

- **Telegram → bot:** registras la URL del Worker una vez con `setWebhook` y Telegram envía cada evento. No hay polling.
- **Bot → Telegram:** el Worker o el DO hacen `fetch()` a la API con el token (guardado como secret).
- **Bot → datos:** sin cadenas de conexión ni contraseñas. D1 y los Durable Objects se declaran como *bindings* en `wrangler.toml` y aparecen en el código como `env.DB` y `env.ROOMS`.
- **El DO también habla con Telegram por su cuenta:** cuando salta una alarm (turno agotado, lobby vencido) no hay petición entrante, así que el DO debe poder editar el mensaje y mover créditos por sí mismo.

**Economía acordada (números pequeños, siempre enteros):**

| Concepto | Valor |
|---|---|
| Créditos iniciales | 100 |
| Bono diario | 10 |
| Rescate | si el saldo baja de 10, se repone hasta 10 (cada 6 h, ajustable) |
| Apuesta mínima | 1 |
| Apuesta máxima | configurable por grupo (por defecto 20) |

## Stack

| Capa | Elección |
|---|---|
| Lenguaje | TypeScript |
| Bot framework | grammY con el adaptador `cloudflare-mod` |
| Punto de entrada | Worker con un `fetch` handler simple (`/webhook` y `/health`), sin framework HTTP |
| Estado de salas | Durable Objects con SQLite (uno por `chat_id`) |
| Datos globales | D1 + Drizzle ORM |
| Config y caché | KV (uso mínimo) |
| Validación | Zod |
| Textos | i18n con archivos de traducción (español por defecto) |
| Tests | Vitest con `@cloudflare/vitest-pool-workers` |
| Despliegue | Wrangler + GitHub Actions |
| Entornos | Dos bots de BotFather (dev y prod), secretos con `wrangler secret` |

**Hono y NestJS quedan fuera** por ahora. Solo hay dos rutas, y un `if` por ruta es más claro que una dependencia. Hono tendría sentido si aparecen muchas rutas HTTP propias (mini app web, panel de administración, un proveedor de pagos externo), y migrar entonces es sencillo. Los pagos con Stars llegan por el mismo webhook de Telegram, así que tampoco lo requieren.

## Alcance

**Dentro (v1):**
- Registro automático al primer comando, en grupo o en privado.
- Billetera con libro de movimientos, bono diario y rescate.
- Motor de salas genérico: lobby, unirse/salir, inicio, turnos, timeouts, cierre y reembolsos.
- Tres juegos: tragamonedas (individual, también en privado), dados y ruleta rusa (grupales).
- Ranking por grupo y global, `/saldo`, `/ayuda`.
- Configuración por grupo para admins: juegos activos y apuesta máxima.
- Textos traducibles desde el día 1.

**Fuera (con la base lista):** compra de créditos, torneos, logros, mini app web, juegos complejos como póker.

**Estructura de clases** (añadir un juego no toca el núcleo):

```
src/
  index.ts     entrada del Worker (exporta también RoomDO)
  core/        wallet.ts (créditos + ledger), rng.ts, i18n/, users.ts
  rooms/       RoomDO.ts, lobby.ts, stateMachine.ts
  games/       types.ts (interfaz GameEngine), registry.ts
               dice/, russian-roulette/, slots/
  telegram/    bot.ts, api.ts, keyboards.ts, renderers.ts, callbackData.ts
  db/          schema.ts, migrations/
```

Cada juego implementa `GameEngine` (`onJoin`, `onStart`, `onAction`, `onTimeout`) y se registra en `registry.ts`. `api.ts` y `wallet.ts` son módulos compartidos, usados tanto por el Worker como por el DO.

## Cosas a tener en cuenta

**Créditos y economía**
- **Ledger de solo escritura** (`transactions`): usuario, monto, motivo, partida, clave de idempotencia. El saldo es una columna cacheada y el ledger es la fuente de verdad.
- Débito con `UPDATE ... WHERE credits >= ?`, para que nunca haya saldo negativo. La apuesta se descuenta al unirse.
- **Reembolso automático** si el lobby se cancela o la partida se cuelga, con un "barrendero" periódico que revisa partidas atascadas.
- **Con números pequeños, los decimales son el enemigo.** Define los pagos con multiplicadores enteros (x2, x3, x5) y, al repartir un pozo, el resto sobrante va a "la casa" o se sortea.
- Un juego gratuito se infla, así que hacen falta "sumideros" (ventaja de la casa, apuestas mínimas, cosméticos futuros) para que el ranking siga significando algo.
- **Anti-abuso:** bono diario limitado por usuario, cooldown del rescate y topes de apuesta.

**Concurrencia y fiabilidad**
- Telegram puede reenviar webhooks: deduplica por `update_id` y haz idempotentes los clics.
- Valida que quien pulsa sea participante y que le toque el turno.
- La información secreta (la bala de la ruleta) vive solo en el DO, nunca en `callback_data`.
- Si un grupo pasa a supergrupo, **cambia su `chat_id`** (Telegram avisa con `migrate_to_chat_id`): hay que migrar la sala.
- `callback_data` admite máximo 64 bytes, y siempre hay que llamar a `answerCallbackQuery`.
- Agrupa las ediciones de mensaje (una cada ~1 s) para no chocar con los límites de Telegram.
- Para el azar usa `crypto.getRandomValues` en vez de `Math.random`, o `sendDice` en la tragamonedas.

**Cloudflare**
- Escribe en D1 al cierre de ronda, no en cada acción (los índices cuentan como escritura extra).
- En el plan gratuito, si superas la cuota diaria las operaciones fallan hasta las 00:00 UTC. El bono diario debería resetear también en UTC.
- Un Worker no guarda memoria entre peticiones: el estado de partidas va en los DO y el de usuarios en D1.

**Privacidad**
- Guarda lo mínimo (id, username, nombre) y ofrece `/privacidad` y `/borrar_mis_datos`.

**Monetización**
- Cuando el bot vende bienes digitales, todas las transacciones deben hacerse en Telegram Stars (XTR), que los usuarios obtienen con compras in-app de Apple/Google o por @PremiumBot. Según guías de integración, el bot necesita los comandos /paysupport, /support y /terms operativos, y los Stars ganados se retiran a Toncoin vía Fragment.
- Prepara desde ahora una tabla `products`, una tabla `payments` (con el id de cargo de Telegram) y un ledger que distinga el origen (`bonus`, `game`, `purchase`).
- **Aviso legal:** vender créditos en juegos tipo casino es una zona delicada (términos de Telegram, políticas de tiendas y regulación de cada país sobre juegos de azar simulados), aunque los créditos no se puedan canjear. No soy abogado: revisa los Términos para Desarrolladores de Telegram y consulta a un profesional antes de cobrar. La postura más segura es que los créditos **nunca tengan valor de canje** ni se puedan transferir entre usuarios por dinero.
- Otras vías de ingreso menos sensibles, combinables con los créditos: cosméticos (avatares, emojis de victoria), pase mensual con ventajas, entradas a torneos con premios no monetarios y eliminación de cooldowns.

## Plan en fases

**Fase 0, Cimientos.** Repo, Wrangler, dos bots (dev/prod), webhook con secret token, CI de despliegue y esquema inicial de D1. *Hecho cuando:* el bot responde `/ping` en producción, atravesando Worker, DO vacío y D1.

**Fase 1, Usuarios y créditos.** Registro automático, billetera con ledger, `/saldo`, `/bono` (10), rescate (<10), `/ranking`, i18n y tests del débito atómico. *Hecho cuando:* no se puede generar saldo negativo ni con clics simultáneos.

**Fase 2, Motor de salas.** `RoomDO` con máquina de estados (IDLE → LOBBY → PLAYING → FINISHED), unirse/salir, alarms de timeout, reembolsos, dedupe de updates e interfaz `GameEngine`. *Hecho cuando:* un juego de prueba completa su ciclo y un lobby cancelado devuelve las apuestas.

**Fase 3, Primeros juegos.**
1. Tragamonedas con `sendDice`.
2. Dados (lobby, apuesta, una ronda, reparto con enteros).
3. Ruleta rusa (turnos, estado secreto, fin por condiciones).

*Hecho cuando:* los tres se juegan de principio a fin en un grupo real.

**Fase 4, Robustez.** Barrendero, migración de supergrupos, configuración por grupo para admins, límites anti-abuso, logs y métricas, `/privacidad` y `/borrar_mis_datos`. *Hecho cuando:* puedes soltarlo en 5 o 10 grupos de prueba sin vigilarlo.

**Fase 5, Enganche.** Rachas del bono diario, rankings semanales, logros, torneos cortos y juegos nuevos. *Se mide con:* retención a 7 días y partidas por usuario.

**Fase 6, Monetización.** Revisión legal, `/terms`, `/support`, `/paysupport`, catálogo, facturas en Stars, reconciliación de pagos con el ledger y protección ante reembolsos y fraude.

Si te cuadra, el siguiente paso es armar el esqueleto de las fases 0 y 1 (proyecto, `wrangler.toml`, esquema de D1 con ledger y el servicio de billetera con sus pruebas). Si prefieres este plan en un documento editable, también puedo prepararlo.