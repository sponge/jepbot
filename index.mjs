import sqlite from 'sqlite';
import machina from 'machina';
import delay from 'delay';

async function main() {
  const db = await sqlite.open('./clues.db', { Promise });
  const clues = await db.all("select * from clues where airdate >= date('now','start of year','-1 year')");
  console.log(clues.length);

  const JepFsm = new machina.BehavioralFsm({
    namespace: 'jep',
    initialState: 'new',

    // fsm-specific options
    defaultGameOptions: {
      autoPickQuestions: true
    },

    states: {
      // setup game options and kick off the game
      new: {
        _onExit: function(game) {
          this.emit('gameStart');
        },

        '*': function(game) {
          game.options = {...this.defaultGameOptions, ...game.options};
          this.transition(game, 'roundStart')
        }
      },

      // a new round has started, fill up the board with questions
      roundStart: {
        _onEnter: async function(game) {
          console.log('round entered, doing some long stuff');
          await delay(2000);
          game.board = {};
          console.log('long stuff done');
          this.transition(game, 'selectQuestion');
        },

        _onExit: function(game) {
          this.emit('roundStart');
        }
      },

      // pick a question from the board based on random or input
      selectQuestion: {
        _onEnter: function(game) {
          if (game.options.autoPickQuestions) {
            this.handle(game, 'chooseQuestion', 1, 1);
          }
        },

        chooseQuestion: function(game, category, level) {
          this.emit("questionSelected", {game, category, level});
          this.transition(game, 'askQuestion');
        }
      },

      // ask the question, and handle answers for answers/timeout
      askQuestion: {
        guess: function(game, guess) {
          console.log(`guessing ${guess}`);
        }
      },
    },

    // convenience functions

    Start: function(game) {
      this.handle(game, 'start');
    },

    Answer: function(game, guess) {
      this.handle(game, 'guess');
    }

  });

  JepFsm.on("gameStart", ev => {
    console.log("Lettuce Start Because I'm Hungry To Play!!!");
  });

  JepFsm.on("roundStart", ev => {
    console.log("We've Got A Hot Board Of Questions For You!!!");
  });

  JepFsm.on("questionSelected", ev => {
    console.log("Get A Load Of This One. It's A Real Thinker:", ev);
  });

  const game = {'players': []};
  JepFsm.Start(game);
}

main();