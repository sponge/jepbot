import Config from './config.mjs';
import GetGameFSM from './fsm.mjs';
import Discord from 'discord.js';
import _ from 'lodash';

import fs from 'fs';
import {promisify} from 'util';

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const access = promisify(fs.access);

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
};

async function renderScores(client, fsm, game) {
  const scores = [];

  for (let score of fsm.GetScores(game)) {
    const user = await client.fetchUser(score[0]);
    const amount = score[1] < 0 ? `-$${score[1]}` : `$${score[1]}`;
    scores.push(`${user}: **${amount}**`);
  }

  return scores.join(', ');
}

function renderScoreBoard(game) {
  const gd = game.data;
  let board = '';
  const maxCategoryLength = _.maxBy(gd.categories, c => c.length).length;

  for (let i = 0; i < gd.categories.length; i++) {
    const header = _.padStart(gd.categories[i], maxCategoryLength, '.');
    board += `\`${i+1}.${header} \` `;

    for (let question of gd.board[i]) {
      board += question.enabled ? emoji[question.cost] : emoji.empty;
    }
    board += '\n';
  }

  return board;
}

function simpleEmbed(title, description) {
  return new Discord.RichEmbed()
    .setTitle(title)
    .setColor(0x000d8b)
    .setDescription(description)
}

function updateStats(stats, id, rightAnswer, amount) {
  if (!stats[id]) {
    stats[id] = { earnings: 0, correct: 0, wrong: 0, accuracy: 0 };
  }

  const player = stats[id];
  player.earnings += amount;
  player.correct = rightAnswer ? 1 : 0;
  player.wrong = rightAnswer ? 0 : 1;
  player.accuracy = player.correct / (player.correct + player.wrong) * 100;

  writeFile('./stats.json', JSON.stringify(stats));
}

async function main() {
  const JepFSM = await GetGameFSM();
  const client = new Discord.Client();

  let stats = {};
  try {
    stats = JSON.parse(await readFile('./stats.json'));
  } catch (e) { }

  const games = {};

  client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
  });
  
  client.on('message', async msg => {
    const game = games[msg.channel.id];

    if (msg.author.bot) {
      return;
    }

    if (!game) {
      if (msg.content === '!jeopardy') {
        const newGame = {channel: msg.channel, options: { autoPickQuestions: false, numCategoriesPerRound: 6, numRounds: 2 }};
        JepFSM.Start(newGame, [msg.author.id]);
        games[msg.channel.id] = newGame;
      }
    } else {
      if (msg.content === '!scores') {
        const scores = await renderScores(client, JepFSM, game);
        const embed = simpleEmbed('Scores', scores);
        game.channel.send(embed);
      } else if (msg.content === '!board') {
        const board = renderScoreBoard(game);
        const embed = simpleEmbed(`Round ${game.data.round}`, board);
        game.channel.send(embed);      
      } else {
        const valid = JepFSM.Command(games[msg.channel.id], msg.author.id, msg.content);
        if (valid === true) {
          msg.react('✅');
        } else if (valid === false) {
          msg.react('❓');
        }
      }
    }
  });

  JepFSM.on('gameStart', ev => {

  });

  JepFSM.on('roundStart', ev => {
    const board = renderScoreBoard(ev.game);
    const embed = simpleEmbed(`Round ${ev.round}`, board);
    ev.game.channel.send(embed);
  });

  JepFSM.on('questionSelectReady', async ev => {
    let board = '';

    // don't show the board if the round has just started
    if (ev.game.data.questionsAsked !== 0) {
      board += renderScoreBoard(ev.game);
    }
    
    const user = await client.fetchUser(ev.player);
    board += `${user}, you're in control. Select a category by saying "(number) for (value)."`;

    // don't show scores if its the start of round 1
    if ((ev.game.data.questionsAsked === 0 && ev.game.data.round === 1) === false) {
      const scores = await renderScores(client, JepFSM, ev.game);
      board += `\n\n${scores}`;
    }

    const embed = simpleEmbed(`Round ${ev.game.data.round}`, board);
    ev.game.channel.send(embed);
  });

  JepFSM.on('questionSelected', ev => {
    const embed = simpleEmbed(`${ev.question.category}: $${ev.question.cost}`, ev.question.question);
    ev.game.channel.send(embed);
  });

  JepFSM.on('rightAnswer', async ev => {
    const scores = await renderScores(client, JepFSM, ev.game);
    const embed = simpleEmbed('Correct!', `"${ev.question.answer}" is the correct answer.\n${scores}`);
    ev.game.channel.send(embed);
    updateStats(stats, ev.player, true, ev.question.cost);
  })

  JepFSM.on('wrongAnswer', async ev => {
    const scores = await renderScores(client, JepFSM, ev.game);
    const embed = simpleEmbed('Incorrect!', scores);
    ev.game.channel.send(embed);
    updateStats(stats, ev.player, false, -ev.question.cost);
  })

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