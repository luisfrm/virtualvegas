__all__ = ['ruleta']
from telegram import Update
from telegram.ext import ContextTypes
import asyncio

async def ruleta(update, context):
    import random
    import time

    # Variables
    ruleta = ['🔫', '💣']
    ruleta_choice = random.choice(ruleta)
    
    chat_id = update.effective_chat.id
    user = update.message.from_user

    # Mensaje
    await context.bot.send_message(chat_id=chat_id, text=f'🔫 {user.first_name} ha jugado a la ruleta rusa...')

    # Animación
    for i in range(4):
        ruleta_choice = random.choice(ruleta)
        await context.bot.send_message(chat_id=chat_id, text=ruleta_choice)
        time.sleep(0.5)
        if ruleta_choice == '💣':
            break
    await context.bot.send_message(chat_id=chat_id, text=ruleta)

    ruleta = '💥' if ruleta == '💣' else '🔫'
    # Comprobar si ha muerto
    if ruleta == '💥':
        await context.bot.send_message(chat_id=chat_id, text=f'💥 {user.first_name} ha muerto...')
    else: 
        await context.bot.send_message(chat_id=chat_id, text=f'🔫 {user.first_name} ha sobrevivido...')