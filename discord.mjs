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

async function renderLifetimeStats(client, stats) {
  const earnings = Object.entries(stats)
    .sort((a, b) => b[1].earnings - a[1].earnings)
    .slice(0, 10);

  const accuracy = Object.entries(stats)
    .sort((a, b) => b[1].accuracy - a[1].accuracy)
    /*.filter(o => o.correct + o.wrong >= 10).*/
    .slice(0, 10);

  const embed = new Discord.RichEmbed()
    .setTitle("Hall of Fame")
    .setColor(0x000d8b);

  let earningsStr = '';
  for (const score of earnings) {
    const user = await client.fetchUser(score[0]);
    earningsStr += `${user}: $${score[1].earnings}\n`;
  }
  embed.addField('Earnings', earningsStr, true);

  let accuracyStr = '';
  for (const score of accuracy) {
    const user = await client.fetchUser(score[0]);
    accuracyStr += `${user}: ${score[1].accuracy.toFixed(1)}%\n`;
  }
  embed.addField('Accuracy', accuracyStr, true);

  return embed;
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

  client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
  });

  client.on('message', async msg => {
    const game = games[msg.channel.id];

    if (msg.author.bot) {
      return;
    }

    switch (msg.content) {
      case '!jeopardy': {
        if (game) { break; }
        const newGame = { channel: msg.channel };
        JepFSM.Start(newGame, [msg.author.id]);
        games[msg.channel.id] = newGame;
        break;
      }

      case '!stats': {
        const statsEmbed = await renderLifetimeStats(client, stats);
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

  JepFSM.on('roundStart', async ev => {
    const board = renderBoard(ev.game);
    const embed = simpleEmbed(`Round ${ev.round}`, board);
    ev.game.boardMessage = await ev.game.channel.send(embed);
  });

  JepFSM.on('questionSelectReady', async ev => {
    let board = '';

    board += renderBoard(ev.game);

    const user = await client.fetchUser(ev.player);
    board += `${user}, select a question.`;

    // don't show help text the whole game
    if (ev.game.data.round === 1 && ev.game.data.questionsAsked <= 4) {
      board += '\nSelect a category by saying "`(number)` for `(value)`."';
    }

    // don't show scores if its the start of round 1
    if ((ev.game.data.questionsAsked === 0 && ev.game.data.round === 1) === false) {
      const scores = await renderScores(client, JepFSM, ev.game);
      board += `\n\n${scores}`;
    }

    const embed = simpleEmbed(`Round ${ev.game.data.round}`, board);

    if (ev.game.boardMessage) {
      ev.game.boardMessage.edit(embed);
    } else {
      const msg = await ev.game.channel.send(embed);
      ev.game.boardMessage = msg;
    }
  });

  JepFSM.on('questionSelected', async ev => {
    const user = await client.fetchUser(ev.player);
    let board = renderBoard(ev.game);
    board += `${user} selected ${ev.question.category} for $${ev.question.cost}`;

    // don't show scores if its the start of round 1
    if ((ev.game.data.questionsAsked === 0 && ev.game.data.round === 1) === false) {
      const scores = await renderScores(client, JepFSM, ev.game);
      board += `\n\n${scores}`;
    }

    const embed = simpleEmbed(`Round ${ev.game.data.round}`, board);

    if (ev.game.boardMessage) {
      ev.game.boardMessage.edit(embed);
      ev.game.boardMessage = null;
    } else {
      ev.game.channel.send(embed);
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
    let question = '';
    if (ev.wagers !== null) {
      const wagers = Object.entries(ev.wagers);
      for (let wager of wagers) {
        wager[0] = await client.fetchUser(wager[0]);
      }
      question += '**Wagers**: ';
      question += wagers.map(w => `${w[0]}: $${w[1]}`).join(', ');
      question += '\n\n';
    }
    question += ev.question.question;
    const embed = simpleEmbed(`${ev.question.category}: $${ev.question.cost}`, question);
    ev.game.channel.send(embed);
  });

  JepFSM.on('rightAnswer', async ev => {
    const user = await client.fetchUser(ev.player);
    const embed = simpleEmbed('Correct!', `${user} guessed "${ev.question.answer}" correctly.`);
    ev.game.channel.send(embed);
    updateStats(stats, ev.player, true, ev.question.cost);
  });

  JepFSM.on('wrongAnswer', async ev => {
    updateStats(stats, ev.player, false, -ev.question.cost);
  });

  JepFSM.on('noAnswer', ev => {
    const embed = simpleEmbed("Time's up!", `The answer is "${ev.question.answer}"`);
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