import Config from './config.mjs';
import GetGameFSM from './fsm.mjs';
import Discord from 'discord.js';

async function getScores(client, game) {
  let scores = '';

  for (let id in game.data.scores) {
    const user = await client.fetchUser(id);
    scores += `${user.username}: ${game.data.scores[id]}\n`;
  }

  return scores;
}

async function main() {
  const JepFSM = await GetGameFSM();
  const client = new Discord.Client();

  const games = {};

  client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
  });
  
  client.on('message', async msg => {
    if (!games[msg.channel.id]) {
      if (msg.content === '!startgame') {
        const newGame = {channel: msg.channel};
        JepFSM.Start(newGame, [msg.author.id]);
        games[msg.channel.id] = newGame;
      }
    } else {
      if (msg.content === '!scores') {
        const game = games[msg.channel.id];
        const scores = await getScores(client, game);
        game.channel.send(scores);
      } else {
        JepFSM.Command(games[msg.channel.id], msg.author.id, msg.content);
      }
    }
  });

  JepFSM.on('gameStart', ev => {
    ev.game.channel.send("Lettuce Start Because I'm Hungry To Play!!!");
  });

  JepFSM.on('roundStart', ev => {
    ev.game.channel.send("We've Got A Hot Board Of Questions For You!!!");
  });

  JepFSM.on('questionSelected', ev => {
    ev.game.channel.send(`
      Get A Load Of This One. It's A Real Thinker:
      ${ev.question.category}
      $${ev.question.cost}
      ${ev.question.question}
    `);
  });

  JepFSM.on('rightAnswer', async ev => {
    const scores = await getScores(client, ev.game);

    ev.game.channel.send(`
      Wow You Are Smarter, Much Smarter Than My Ex-Wife!
      ${ev.player} guessed ${ev.game.data.question.answer} right
      ${scores}
    `);
  })

  JepFSM.on('wrongAnswer', ev => {
    ev.game.channel.send(`
      You Fool! ${ev.player} guessed "${ev.guess}" wrong
    `);
  })

  JepFSM.on('noAnswer', ev => {
    ev.game.channel.send(`
      Stumped Ya Good, Ya Dingus
      The answer was ${ev.game.data.question.answer}
    `);
  });

  JepFSM.on('roundOver', async ev => {
    const scores = await getScores(client, ev.game);

    ev.game.channel.send(`
      I May Be Square But Even I Can Tell This Round Is Over!
      ${scores}
    `);
  });

  JepFSM.on('gameOver', async ev => {
    const scores = await getScores(client, ev.game);

    ev.game.channel.send(`
      Thank's For Playing!
      ${scores}
    `);
  });

  client.login(Config.token);
}
main();