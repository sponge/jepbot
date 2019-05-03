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
      questionTime: 8000,
      timeBetweenQuestions: 2000,
      timeBetweenRounds: 4000,
      autoPickQuestions: true,
      gameRounds: 2,
      useFinalRound: false,
    },

    states: {
      // setup game options and kick off the game
      new: {
        _onExit: function(game) {
          this.emit('gameStart');
        },

        '*': function(game) {
          game.options = {...this.defaultGameOptions, ...game.options};
          game.round = 0;
          this.transition(game, 'roundStart')
        }
      },

      // a new round has started, fill up the board with questions
      roundStart: {
        _onEnter: async function(game) {
          console.log('round entered, doing some long stuff');
          await delay(2000);
          game.board = {};
          game.round += 1;
          game.cluesLeft = 3;
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

        // handle and validate question selection
        chooseQuestion: function(game, category, level) {
          this.emit('questionSelected', {game, category, level});
          this.transition(game, 'askQuestion');
        }
      },

      // ask the question, and handle input for answers/question timeout
      askQuestion: {
        // setup question timeout
        _onEnter: function(game) {
          game.timer = setTimeout(() => this.transition(game, 'noAnswer'), game.options.questionTime);
        },

        _onExit: function(game) {
          clearTimeout(game.timer);
        },

        // handle guesses from player
        guess: function(game, guess) {
          if (Math.random() > 0.5) {
            this.emit('rightAnswer', game);
            this.transition(game, 'questionOver');
          } else {
            this.emit('wrongAnswer', game);
          }
        }
      },

      // nobody guessed the answer in time. emit an event so we can print a message out and move on
      noAnswer: {
        _onEnter: function(game) {
          this.emit('noAnswer', game);
          this.transition(game, 'questionOver');
        }
      },

      questionOver: {
        _onEnter: async function(game) {
          // if the board is empty, move on to the next round
          game.cluesLeft -= 1;
          if (game.cluesLeft === 0) {
            this.transition(game, 'roundOver');
          } else {
            // otherwise, move on to the next question
            await delay(game.options.timeBetweenQuestions);
            this.transition(game, 'selectQuestion');
          }
        }
      },

      roundOver: {
        _onEnter: async function(game) {
          this.emit('roundOver', game);
          // check if we need to move into final jeopardy
          await delay(game.options.timeBetweenRounds);
          if (game.round === game.options.gameRounds) {
            if (game.options.useFinalRound) {
              // move into final round
            } else {
              this.transition(game, 'gameOver');
            }
          } else {
            this.transition(game, 'roundStart');
          }
        }
      },

      gameOver: {
        _onEnter: function(game) {
          this.emit('gameOver', game);
        }
      }
    },

    // convenience functions

    Start: function(game) {
      this.handle(game, 'start');
    },

    Guess: function(game, guess) {
      this.handle(game, 'guess');
    }

  });

  JepFsm.on('gameStart', ev => {
    console.log("Lettuce Start Because I'm Hungry To Play!!!");
  });

  JepFsm.on('roundStart', ev => {
    console.log("We've Got A Hot Board Of Questions For You!!!");
  });

  JepFsm.on('questionSelected', ev => {
    console.log("Get A Load Of This One. It's A Real Thinker:", ev);
  });

  JepFsm.on('rightAnswer', ev => {
    console.log('Wow You Are Smarter, Much Smarter Than My Ex-Wife!', ev);
  })

  JepFsm.on('wrongAnswer', ev => {
    console.log("You Fool!", ev);
  })

  JepFsm.on('noAnswer', ev => {
    console.log('Stumped Ya Good, Ya Dingus', ev);
  });

  JepFsm.on('roundOver', ev => {
    console.log('I May Be Square But Even I Can Tell This Round Is Over!', ev);
  });

  JepFsm.on('gameOver', ev => {
    console.log("Thank's For Playing!", ev);
  });

  const game = {'players': []};
  JepFsm.Start(game);

  // global.jep.Guess(global.game, 'hello')
  global.game = game;
  global.jep = JepFsm;
}

main();