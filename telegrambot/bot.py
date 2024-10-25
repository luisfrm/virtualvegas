from telegram import Update
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes
from ruleta import ruleta


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(f'Hola {update.effective_user.first_name}! Tu pareja te pone los cuernos.')

token = '8128250076:AAGqVovz43MQCs1pphpyVcEF0RHHuFIrNjY'
app = ApplicationBuilder().token(token).build()

app.add_handler(CommandHandler("start", start))
app.add_handler(CommandHandler("ruleta", ruleta))

app.run_polling()