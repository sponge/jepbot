  import GetGameFSM from './fsm.mjs';

  async function main() {
    const JepFSM = await GetGameFSM();
    
    JepFSM.on('gameStart', ev => {
      console.log("Lettuce Start Because I'm Hungry To Play!!!");
    });

    JepFSM.on('roundStart', ev => {
      console.log("We've Got A Hot Board Of Questions For You!!!");
    });

    JepFSM.on('questionSelected', ev => {
      console.log("Get A Load Of This One. It's A Real Thinker:", ev);
      console.log(`${ev.question.category}\n$${ev.question.cost}\n${ev.question.question}\n(answer: ${ev.question.answer})`);
    });

    JepFSM.on('rightAnswer', ev => {
      console.log('Wow You Are Smarter, Much Smarter Than My Ex-Wife!', ev);
      console.log(`${ev.player} guessed ${ev.game.data.question.answer} right`);
      console.log(JSON.stringify(ev.game.data.scores));
    })

    JepFSM.on('wrongAnswer', ev => {
      console.log("You Fool!", ev);
      console.log(`player ${ev.player} guessed "${ev.guess} wrong"`);
      console.log(JSON.stringify(ev.game.data.scores));
    })

    JepFSM.on('noAnswer', ev => {
      console.log('Stumped Ya Good, Ya Dingus', ev);
      console.log(`answer was ${ev.game.data.question.answer}`);
    });

    JepFSM.on('roundOver', ev => {
      console.log('I May Be Square But Even I Can Tell This Round Is Over!', ev);
    });

    JepFSM.on('gameOver', ev => {
      console.log("Thank's For Playing!", ev);
    });

    const game = {channel: 123456};
    JepFSM.Start(game);

    // global.jep.Command(global.game, 'sponge', 'what is the answer')
    global.game = game;
    global.jep = JepFSM;
  }

  main();