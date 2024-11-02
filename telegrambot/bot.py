from telegram import Update
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes
import logging
from dotenv import load_dotenv
from os import getenv
from telegram.ext import CallbackQueryHandler
from ruleta import button_callback, ruleta_menu

# Carga las variables de entorno del archivo .env
load_dotenv()

telegram_token = getenv('TELEGRAM_BOT_TOKEN')

# Configuración del logging
logging.basicConfig(format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', level=logging.INFO)
logger = logging.getLogger(__name__)

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(f'Hola {update.effective_user.first_name}! Tu pareja te pone los cuernos.')
    
async def error_handler(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    logger.error(f"Exception while handling an update: {context.error}")
    if update.effective_chat:
        await context.bot.send_message(chat_id=update.effective_chat.id, 
                                       text="Lo siento, ocurrió un error. Por favor, intenta de nuevo más tarde.")
    
def main() -> None:
    token = getenv('TELEGRAM_BOT_TOKEN')
    if not token:
        raise ValueError("No se encontró el token del bot en las variables de entorno")

    app = ApplicationBuilder().token(telegram_token).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("ruleta", ruleta_menu))

    app.add_handler(CallbackQueryHandler(button_callback))
    
    # Añadir el manejador de errores
    app.add_error_handler(error_handler)

    app.run_polling()

# app = ApplicationBuilder().token(telegram_token).build()
# application.add_handler(CallbackQueryHandler(button_callback))

# app.add_handler(CommandHandler("start", start))
# app.add_handler(CommandHandler("ruleta", ruleta))

# app.run_polling()

if __name__ == '__main__':
    main()