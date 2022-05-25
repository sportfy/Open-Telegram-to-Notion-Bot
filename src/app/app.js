const { Bot, session } = require('grammy');
require('dotenv').config()

//Controllers
const DatabaseQuerys = require('../controller/DatabaseQuerys');
const AppController = require('../controller/AppController');

//Commands
const start = require('./commands/start');
const auth = require('./commands/auth');
const help = require('./commands/help');
const announcement = require('./commands/announcement');
const roadmap = require('./commands/roadmap');

const bot = new Bot(process.env.BOT_TOKEN)

// Setting default session for user
function initialSesionValues() {
    return {waitingForAuthCode: false, waitingForAnnouncementMessage: false};
}

bot.use(session({ initial: initialSesionValues }));

// Set a middleware for reject other users when the bot is on development
bot.use(async (ctx, next) => {
    
    if (process.env.NODE_ENV !== "development") {
        await next()
        return
    }

    if (ctx.from.id !== parseInt(process.env.MY_USER_ID)) {
        ctx.reply('⚠️ Sorry, this bot is on development for now... \nStay alert for new updates! \nrepo: https://github.com/FranP-code/Telegram-to-Notion-Bot')
        return
    }

    next()
})

//Set a middleware for check if the bot is waiting the auth code
bot.use(async (ctx, next) => {
    if (ctx.session.waitingForAuthCode) {

        ctx.session.waitingForAuthCode = false

        const response = await DatabaseQuerys().uploadApiKey(ctx.from.id, ctx.message.text)

        if (response.status === "error" && response.message === "Auth key not valid") {
            ctx.reply("Auth code not valid, type /auth again")
            return
        }
        
        if (response.status === "success"){
            ctx.reply("Auth code registered 👍\n\nSend a message to *add it to the database you select*", {parse_mode: "MarkdownV2"})
            return
        }

        if (response.status === "error") {
            ctx.reply("'Unknow error, please try again later'")
            return
        }

    } else {
        await next()
    }
})

//Set a middleware for check if the bot is waiting the announcement
bot.use(async (ctx, next) => {
    if (ctx.session.waitingForAnnouncementMessage) {
        
        ctx.session.waitingForAnnouncementMessage = false

        //Check if user is not me
        if (ctx.from.id !== parseInt(process.env.MY_USER_ID)) {
            ctx.reply("<strong>What the fuck are you doing here?</strong>", {parse_mode: "HTML"})
            bot.api.sendMessage(process.env.MY_USER_ID, "Somebody is making announcements. STOP THE BOT.", {parse_mode: "HTML"})
            return
        }

        //Check if the announcement have been cancelled
        if (ctx.message.text.trim().toLowerCase() === "cancel") {
            ctx.reply("Announcement cancelled")
            return
        }

        let users
        
        if (process.env.NODE_ENV === "development") {
            users = [
                await DatabaseQuerys().getUser(process.env.TESTING_USER_ID),
                await DatabaseQuerys().getUser(process.env.MY_USER_ID)
            ]
            users = users.map(user => user.data) //wtf js
        }

        if (process.env.NODE_ENV === "production") {
            users = await DatabaseQuerys().getAllUsers()
            users = users.data //wtf js
        }

        users.forEach((user, index) => {
            setTimeout(async () => {
                try {
                    await bot.api.sendMessage(user.userId, ctx.message.text, {parse_mode: "HTML"})
                    console.log(`Message sended to ${user.userId}`)
                } catch (err) {
                    console.log(err)
                }

                if (index === users.length - 1) {
                    ctx.reply(`Announcement complete.`)
                }
            }, 30000 * index)
        });


    } else {
        next()
    }
})

//Set a middleware for send a 'typing' state every time the bot is called
bot.use((ctx, next) => {
    ctx.replyWithChatAction("typing")
    next()
})

// Start command
bot.command('start', start)

// Auth message sending
bot.command('auth', auth)

// Help command
bot.command('help', help)

// Announcement command
bot.command("announcement", announcement)

// Roadmap command
bot.command("roadmap", roadmap)

/**
 ** Little note: all the commands are before the on(:text) of the bot
 */

// On the message sending, exec the main function of the bot
bot.on(':text', async ctx => {

    const response = await AppController().getNotionDatabases(ctx.from.id)

    if (response.status === "error") {
        
        switch (response.message) {
            case "no auth code":
                ctx.reply('No auth code provided\n*Use the /auth command for provide it*', {parse_mode: "MarkdownV2"})
                break;
        
            default:
                ctx.reply('Unknow error\n*Try again later*', {parse_mode: "MarkdownV2"})
                break;
        }

        return
    }

    ctx.session.textForAdd = ctx.message.text

    ctx.reply("Select the database to *save this text*", {
        reply_markup: {
            inline_keyboard: [
                ...response.results.map((obj) => {
                        const title = obj.title.length <= 0 ?  "Untitled" : obj.title[0].text.content

                        if (obj.properties.telegramIgnore) {
                            return []
                        }

                        if (obj.icon) {
                            return [{
                                text: `${obj.icon.emoji ? obj.icon.emoji + " " : ""}${title}`,
                                callback_data: "database_id" + obj.id
                            }]
                        } else {
                            return [{
                                text: title,
                                callback_data: "database_id" + obj.id
                            }]
                        }
                    }),
                    [
                        {text: "🚫", callback_data: "cancel_operation"}
                    ]
                ]
        },
        parse_mode: "MarkdownV2"
    })
})

//Handle the text sended for the user
bot.on("callback_query:data", async ctx => {

    let id = ctx.update.callback_query.data
    const text = ctx.session.textForAdd

    // Clean the state of the text
    ctx.session.textForAdd = false

    //In case that the cancel button is pressed
    if (id === "cancel_operation") {
        deleteMessage(ctx, ctx.update.callback_query.message.message_id)
        ctx.reply(`Operation canceled 👍`, {parse_mode: "HTML"})
        return
    }

    // Check if the data includes the prefix indicated
    if (!id.includes("database_id")) {
        reportError(ctx)
        return
    }

    // Delete the prefix
    id = id.split('database_id')[1]

    const response = await AppController().addMessageToNotionDatabase(ctx.from.id, id, text)

    if (response.status === "error") {
        deleteMessage(ctx, ctx.update.callback_query.message.message_id)
        reportError(ctx)
        return
    }

    ctx.reply(`<strong>${text}</strong> added to <strong>${response.databaseTitle}</strong> database 👍`, {parse_mode: "HTML"})
    deleteMessage(ctx, ctx.update.callback_query.message.message_id)
})

// Delete message function
async function deleteMessage(ctx, messageId) {
    try {
        await ctx.api.deleteMessage(ctx.chat.id, messageId)
    } catch (error) {
        console.log(error)
    }
}

// Error message function
function reportError(ctx) {
    ctx.reply("Has been an error. Try again later")
}

bot.on(':sticker', ctx => {
    ctx.reply('❤️')
})

bot.on(':photo', ctx => {
    ctx.reply("<strong>Pictures are not allowed...</strong>", {parse_mode: "HTML"})
    
    setTimeout(() => {
        ctx.reply("<strong>...yet</strong>", {parse_mode: "HTML"})
    }, 3500)
})

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))

bot.start()

// Fuck Telegraf
// My hommies and I hate Telegraf
// Grammy for the win