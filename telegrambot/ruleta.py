import random
import asyncio
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes

__all__ = ['ruleta', 'ruleta_menu', 'button_callback']

async def ruleta_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    keyboard = [
        [InlineKeyboardButton("Jugar Ruleta Rusa 🎲", callback_data='jugar_ruleta')],
        [InlineKeyboardButton("Reglas 📜", callback_data='reglas_ruleta')],
        [InlineKeyboardButton("Estadísticas 📊", callback_data='stats_ruleta')]
    ]
    reply_markup = InlineKeyboardMarkup(keyboard)
    await update.message.reply_text('Bienvenido al juego de Ruleta Rusa. ¿Qué deseas hacer?', reply_markup=reply_markup)

# Versión anterior de la función ruleta
async def ruleta(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        # Variables
        ruleta_opciones = ['🔫', '🔫', '🔫', '🔫', '🔫', '💣']
        
        # Obtener el chat_id y el usuario de manera segura
        if update.message:
            chat_id = update.message.chat_id
            user = update.message.from_user
        elif update.callback_query:
            chat_id = update.callback_query.message.chat_id
            user = update.callback_query.from_user
        else:
            raise ValueError("No se pudo obtener la información del chat o usuario")

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
    except Exception as e:
        print(f"Error en la ruleta: {e}")

async def button_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()

    if query.data == 'jugar_ruleta':
        await query.edit_message_text(text="¡Preparando el juego de Ruleta Rusa!")
        # Aquí llamarías a tu función de juego de ruleta
        await ruleta(update, context)
    elif query.data == 'reglas_ruleta':
        reglas = (
            "Reglas de la Ruleta Rusa:\n\n"
            "1. El juego simula una ruleta rusa con un revólver.\n"
            "2. Hay una probabilidad de 1/6 de 'perder'.\n"
            "3. Si sobrevives, ganas puntos y puedes seguir jugando.\n"
            "4. Si pierdes, el juego termina.\n"
            "5. ¡Juega bajo tu propio riesgo!"
        )
        await query.edit_message_text(text=reglas)
    elif query.data == 'stats_ruleta':
        # Aquí podrías implementar la lógica para mostrar estadísticas
        await query.edit_message_text(text="Función de estadísticas en desarrollo.")