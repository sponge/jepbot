import Config from './config.mjs';
import GetGameFSM from './fsm.mjs';
import Discord from 'discord.js';
import _ from 'lodash';

import fs from 'fs';
import { promisify } from 'util';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

const emoji = {
  200: '<:jep200:573971965560356874>',
  400: '<:jep400:573971965463756811>',
  600: '<:jep600:573971965581197312>',
  800: '<:jep800:573971965573070848>',
  1000: '<:jep1000:573971965568614450>',
  1200: '<:jep1200:573971965627465728>',
  1600: '<:jep1600:573971965614882866>',
  2000: '<:jep2000:573971965442916380>',
  empty: '<:jepempty:573971965573070858>',
  glow: '<:jepglow:574412831714181120>',
};

const rulesPresets = {
  full: {
    description: 'The classic game, full length.',
    options: {}
  },

  quick: {
    description: 'A shorter experience to just chill and answer questions. 1 round, questions are randomly picked.',
    options: { numRounds: 1, autoPickQuestions: true }
  },

  buzz: {
    description: '(Very WIP!) Join a voice channel and use your push to talk or type "." to buzz in before answering.',
    options: { useBuzzer: true }
  }
};

async function renderScores(client, fsm, game) {
  const scores = [];

  for (const score of fsm.GetScores(game)) {
    const user = await client.fetchUser(score[0]);
    const amount = score[1] < 0 ? `-$${Math.abs(score[1])}` : `$${score[1]}`;
    scores.push(`${user}: **${amount}**`);
  }

  return scores.join(', ');
}

function renderBoard(game) {
  const gd = game.data;
  let board = '';
  const maxCategoryLength = _.maxBy(gd.categories, c => c.length).length;

  for (let i = 0; i < gd.categories.length; i++) {
    const header = _.padStart(gd.categories[i], maxCategoryLength, '.');
    board += `\`${i + 1}.${header} \` `;

    for (let question of gd.board[i]) {
      board += gd.question === question ? emoji.glow : question.enabled ? emoji[question.cost] : emoji.empty;
    }
    board += '\n';
  }

  return board;
}

async function renderLifetimeStats(client, stats, members) {
  const earnings = Object.entries(stats)
    .map(o => [o[0], o[1].earnings])
    .sort((a, b) => b[1] - a[1])
    .map(o => [o[0], '$'+ o[1]]);


  const accuracy = Object.entries(stats)
    .filter(o => o[1].correct + o[1].wrong >= 20)
    .map(o => [o[0], o[1].accuracy])
    .sort((a, b) => b[1] - a[1])
    .map(o => [o[0], o[1].toFixed(1) + '%']);

  const embed = new Discord.RichEmbed()
    .setTitle("Hall of Fame")
    .setColor(0x000d8b);

  const boards = [['Earnings', earnings], ['Accuracy', accuracy]];

  for (const board of boards) {
    let boardStr = '';
    const filteredBoard = board[1].filter(score => members.get(score[0]) !== undefined).slice(0, 10);
    for (const score of filteredBoard) {
      const user = await client.fetchUser(score[0]);
      boardStr += `${user}: ${score[1]}\n`;
    }
    embed.addField('Local ' + board[0], boardStr.length ? boardStr : 'No local players', true);
  }

  for (const board of boards) {
    let boardStr = '';
    const filteredBoard = board[1].slice(0, 5);
    for (const score of filteredBoard) {
      const user = await client.fetchUser(score[0]);
      boardStr += `${user.tag}: ${score[1]}\n`;
    }
    embed.addField('Global ' + board[0], boardStr.length ? boardStr : 'No global players', true);
  } 

  return embed;
}

async function renderBoardMessage(client, fsm, game) {
  const gd = game.data;
  let board = '';

  board += renderBoard(game);

  if (!gd.question) {
    const user = await client.fetchUser(gd.boardControl);
    board += `${user}, select a question.`;

    // don't show help text the whole game
    if (gd.round === 1 && gd.questionsAsked <= 4) {
      board += '\nSelect a category by saying "`(number)` for `(value)`."';
    }
  } else {
    const user = await client.fetchUser(gd.boardControl);
    board += `${user} selected ${gd.question.category} for $${gd.question.cost}`;
  }

  // don't show scores if its the start of round 1
  if ((gd.questionsAsked === 0 && gd.round === 1) === false) {
    const scores = await renderScores(client, fsm, game);
    board += `\n\n${scores}`;
  }

  return simpleEmbed(`Round ${gd.round}`, board);
}

async function renderQuestion(game, client) {
  const gd = game.data;
  let question = '';
  if (gd.wagers !== null) {
    const wagers = Object.entries(gd.wagers);
    for (let wager of wagers) {
      wager[0] = await client.fetchUser(wager[0]);
    }
    question += '**Wagers**: ';
    question += wagers.map(w => `${w[0]}: $${w[1]}`).join(', ');
    question += '\n\n';
  }
  question += gd.question.question;

  if (game.options.useBuzzer && !gd.buzzPlayer && !gd.wagers) {
    question += '\n\n**BUZZ IN NOW!**';
  } else if (gd.buzzPlayer) {        
    const user = await client.fetchUser(gd.buzzPlayer);
    question += `\n\n${user}, please give your answer.`;
  }

  return simpleEmbed(`${gd.question.category}: $${gd.question.cost}`, question);
}

function simpleEmbed(title, description) {
  return new Discord.RichEmbed()
    .setTitle(title)
    .setColor(0x000d8b)
    .setDescription(description);
}

function updateStats(stats, id, rightAnswer, amount) {
  if (!stats[id]) {
    stats[id] = { earnings: 0, correct: 0, wrong: 0, accuracy: 0 };
  }

  const player = stats[id];
  player.earnings += amount;
  player.correct += rightAnswer ? 1 : 0;
  player.wrong += rightAnswer ? 0 : 1;
  player.accuracy = player.correct / (player.correct + player.wrong) * 100;

  writeFile('./stats.json', JSON.stringify(stats, null, 2));
}

async function main() {
  const JepFSM = await GetGameFSM();
  const client = new Discord.Client();

  let stats = {};
  try {
    stats = JSON.parse(await readFile('./stats.json'));
  } catch (e) {
    console.log("No stats.json found, starting new stats");
  }

  const games = {};
  const voiceGames = {};

  client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
  });

  client.on('message', async msg => {
    const game = games[msg.channel.id];

    if (msg.author.bot) {
      return;
    }

    const args = msg.content.split(' ');

    switch (args[0]) {
      case '!jeopardy': {
        if (game) { break; }
        if (!args[1] || args[1] in rulesPresets === false) {
          const choices = Object.entries(rulesPresets).map(o => `**!jeopardy ${o[0]}**: ${o[1].description}`).join('\n');
          msg.reply('\n' + choices + '\n\n' + 'Post issues and suggestions at <https://github.com/sponge/jepbot>');
          break;
        }

        const newGame = {
          channel: msg.channel,
          boardMessage: null,
          questionMessage: null,
          options: rulesPresets[args[1]].options
        };

        if (args[1] === 'buzz') {
          if (!msg.member.voiceChannel) {
            msg.reply('join a voice channel to play with buzzers.');
            break;
          }

          await msg.member.voiceChannel.join();
          voiceGames[msg.member.voiceChannel] = newGame;
        }

        JepFSM.Start(newGame, [msg.author.id]);
        games[msg.channel.id] = newGame;
        voiceGames[msg.member.voiceChannelID] = newGame;
        break;
      }

      case '!stats': {
        const statsEmbed = await renderLifetimeStats(client, stats, msg.channel.members);
        msg.reply(statsEmbed);
        break;
      }

      case '!scores': {
        if (!game) { break; }
        const scores = await renderScores(client, JepFSM, game);
        const embed = simpleEmbed('Scores', scores);
        game.channel.send(embed);
        break;
      }

      case '!board': {
        if (!game) { break; }
        const board = renderBoard(game);
        const embed = simpleEmbed(`Round ${game.data.round}`, board);
        game.channel.send(embed);
        break;
      }

      case '!status': {
        if (msg.author.tag !== 'sponge#6969') { break; }
        let status = '\n';
        status += `Running in ${client.guilds.size} servers\n`;
        status += `Currently ${Object.keys(games).length} active games.\n`;
        Object.entries(games).forEach(game => {
          const channel = client.channels.get(game[0]);
          status += `${channel.guild.name} - #${channel.name}: Round ${game[1].data.round} of ${game[1].options.numRounds}, ${game[1].data.questionsLeft} questions left\n`;
        });

        msg.reply(status);
        break;
      }

      case '!announce': {
        if (msg.author.tag !== 'sponge#6969') { break; }
        if (!args[1]) { break; }
        Object.entries(games).forEach(game => {
          const channel = client.channels.get(game[0]);
          channel.send(simpleEmbed("Announcement from Alex Trebek", args.slice(1).join(' ')));
        });
        break;
      }

      case '.': {
        const game = games[msg.channel.id];

        if (!game) {
          return;
        }
    
        JepFSM.Buzz(game, msg.author.id);   
        break;     
      }

      default: {
        if (!game) { break; }
        const status = JepFSM.Command(games[msg.channel.id], msg.author.id, msg.content);
        if (status === 'unknown') {
          msg.react('❓');
        } else if (status === 'wrongAnswer') {
          //msg.react('🔻').then(() => msg.react('💰'));
          msg.react('💸');
        } else if (status === 'wager') {
          msg.react('✅');
        } else if (status === 'badWager') {
          msg.react('🚫');
        }
      }
    }
  });

  client.on('guildMemberSpeaking', (member, speaking) => {
    const game = voiceGames[member.voiceChannelID];

    if (!game || !speaking) {
      return;
    }

    JepFSM.Buzz(game, member.id);
  });

  JepFSM.on('roundStart', async ev => {
    const board = renderBoard(ev.game);
    const embed = simpleEmbed(`Round ${ev.round}`, board);
    ev.game.boardMessage = await ev.game.channel.send(embed);
  });

  JepFSM.on('questionSelectReady', async ev => {
    const embed = await renderBoardMessage(client, JepFSM, ev.game);
    
    if (ev.game.boardMessage) {
      ev.game.boardMessage.edit(embed);
    } else {
      const msg = await ev.game.channel.send(embed);
      ev.game.boardMessage = msg;
    }
  });

  JepFSM.on('questionSelected', async ev => {
    const embed = await renderBoardMessage(client, JepFSM, ev.game);
  
    if (ev.game.boardMessage) {
      ev.game.boardMessage.edit(embed);
      ev.game.boardMessage = null;
    } else {
      const msg = await ev.game.channel.send(embed);
      ev.game.boardMessage = msg;
    }
  });

  JepFSM.on('askWager', async ev => {
    if (ev.type === 'dailydouble') {
      const player = Object.keys(ev.wagers)[0];
      const user = await client.fetchUser(player);
      const range = JepFSM.GetValidWagerRange(ev.game, player);
      const embed = simpleEmbed('Daily Double!', `${user}, say the dollar amount you wish to wager. You can wager between $${range[0]} and $${range[1]}`);

      ev.game.channel.send(embed);
    }
  });

  JepFSM.on('askQuestion', async ev => {
    const embed = await renderQuestion(ev.game, client);
    const msg = await ev.game.channel.send(embed);
    ev.game.questionMessage = msg;
  });

  JepFSM.on('onBuzz', async ev => {
    const embed = await renderQuestion(ev.game, client);

    if (ev.game.questionMessage) {
      ev.game.questionMessage.edit(embed);
    } else {
      const msg = await ev.game.channel.send(embed);
      ev.game.questionMessage = msg;
    }
  });

  JepFSM.on('rightAnswer', async ev => {
    const user = await client.fetchUser(ev.player);
    const embed = simpleEmbed('Correct!', `${user} guessed "${ev.question.answer}" correctly.`);
    ev.game.questionMessage = null;
    ev.game.channel.send(embed);
    updateStats(stats, ev.player, true, ev.question.cost);
  });

  JepFSM.on('wrongAnswer', async ev => {
    updateStats(stats, ev.player, false, -ev.question.cost);

    if (ev.game.options.useBuzzer) {
      const embed = await renderQuestion(ev.game, client);

      if (ev.game.questionMessage) {
        ev.game.questionMessage.edit(embed);
      } else {
        const msg = await ev.game.channel.send(embed);
        ev.game.questionMessage = msg;
      }
    }
  });

  JepFSM.on('noAnswer', ev => {
    const embed = simpleEmbed("Time's up!", `The answer is "${ev.question.answer}"`);
    ev.game.questionMessage = null;
    ev.game.channel.send(embed);
  });

  JepFSM.on('roundOver', async ev => {
    const scores = await renderScores(client, JepFSM, ev.game);
    const embed = simpleEmbed('Round over!', scores);
    ev.game.channel.send(embed);
  });

  JepFSM.on('gameOver', async ev => {
    delete games[ev.game.channel.id];

    const scores = await renderScores(client, JepFSM, ev.game);
    const embed = simpleEmbed('Game Over!', `${scores}\nThanks for playing!`);
    ev.game.channel.send(embed);
  });

  client.login(Config.token);
}
main();