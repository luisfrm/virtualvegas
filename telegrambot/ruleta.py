import random
import asyncio
from telegram import Update
from telegram.ext import ContextTypes

__all__ = ['ruleta']

async def ruleta(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # Variables
    ruleta_opciones = ['🔫', '💣']
    chat_id = update.effective_chat.id
    user = update.message.from_user

    # Inicializar o reiniciar el estado del juego para este usuario
    context.user_data['ruleta_state'] = {
        'ultima_eleccion': None,
        'resultado': None
    }

    # Mensaje inicial
    await context.bot.send_message(chat_id=chat_id, text=f'🔫 {user.first_name} ha jugado a la ruleta rusa...')

    # Animación
    for i in range(4):
        ruleta_choice = random.choice(ruleta_opciones)
        context.user_data['ruleta_state']['ultima_eleccion'] = ruleta_choice
        await context.bot.send_message(chat_id=chat_id, text=ruleta_choice)
        await asyncio.sleep(0.5)
        if ruleta_choice == '💣':
            break

    # Determinar el resultado final
    resultado = '💥' if context.user_data['ruleta_state']['ultima_eleccion'] == '💣' else '🔫'
    context.user_data['ruleta_state']['resultado'] = resultado

    # Mostrar el resultado
    await context.bot.send_message(chat_id=chat_id, text=resultado)

    # Comprobar si ha muerto
    if resultado == '💥':
        await context.bot.send_message(chat_id=chat_id, text=f'💥 {user.first_name} ha muerto...')
    else: 
        await context.bot.send_message(chat_id=chat_id, text=f'🔫 {user.first_name} ha sobrevivido...')

    # Opcional: Mostrar el estado final
    await context.bot.send_message(chat_id=chat_id, text=f"Estado final: {context.user_data['ruleta_state']}")