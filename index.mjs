import sqlite from 'sqlite';
import machina from 'machina';
import delay from 'delay';
import distance from 'damerau-levenshtein';

function closeEnough(a, b, similarity) {
  const regex = /\s|\W/gm;
  const trim_a = a.replace(regex, '').toLowerCase();
  const trim_b = b.replace(regex, '').toLowerCase();
  const score = distance(trim_a, trim_b);
  return score.similarity >= similarity;
}

async function main() {
  const db = await sqlite.open('./clues.db', { Promise });
  const clues = await db.all("select * from clues where airdate >= date('now','start of year','-1 year')");
  console.log(clues.length);

  const JepFsm = new machina.BehavioralFsm({
    namespace: 'jep',
    initialState: 'new',

    // fsm-specific options
    defaultGameOptions: {
      questionTime: 15000,
      timeBetweenQuestions: 2000,
      timeBetweenRounds: 4000,
      autoPickQuestions: true,
      gameRounds: 2,
      useFinalRound: false,
      guessesPerQuestion: 1,
      answerSimilarity: 0.7,
    },

    states: {
      // setup game options and kick off the game
      new: {
        _onExit: function(game) {
          this.emit('gameStart', {game});
        },

        '*': function(game) {
          game.options = {...this.defaultGameOptions, ...game.options};
          game.data = {
            round: 0,
            board: {},
            scores: {},
            question: null,
            questionsLeft: 3
          };
          this.transition(game, 'roundStart')
        }
      },

      // a new round has started, fill up the board with questions
      roundStart: {
        _onEnter: async function(game) {
          console.log('round entered, doing some long stuff');
          await delay(2000);
          game.data.board = {};
          game.data.round += 1;
          game.data.questionsLeft = 3;
          console.log('long stuff done');
          this.transition(game, 'selectQuestion');
        },

        _onExit: function(game) {
          this.emit('roundStart', {game});
        }
      },

      // pick a question from the board based on random or input
      selectQuestion: {
        _onEnter: function(game) {
          game.data.question = null;

          if (game.options.autoPickQuestions) {
            this.handle(game, 'chooseQuestion', 1, 1);
          }
        },

        _onExit: function(game) {
          game.data.guesses = {};
        },

        // handle and validate question selection
        chooseQuestion: function(game, category, level) {
          game.data.question = {category, level, question: 'abc', answer: 'defdefdef'};
          this.emit('questionSelected', {game});
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
        guess: function(game, player, guess) {
          const d = game.data;

          if (!d.scores[player]) {
            d.scores[player] = 0;
          }

          if (!d.guesses[player]) {
            d.guesses[player] = 0;
          }

          if (d.guesses[player] >= game.options.guessesPerQuestion) {
            return;
          }

          if (closeEnough(guess, d.question.answer, game.options.answerSimilarity)) {
            d.scores[player] += d.question.level * d.round * 200;
            this.emit('rightAnswer', {game, player, guess});
            this.transition(game, 'questionOver');
          } else {
            d.scores[player] -= d.question.level * d.round * 200;
            d.guesses[player] += 1;
            this.emit('wrongAnswer', {game, player, guess});
          }
        }
      },

      // nobody guessed the answer in time. emit an event so we can print a message out and move on
      noAnswer: {
        _onEnter: function(game) {
          this.emit('noAnswer', {game});
          this.transition(game, 'questionOver');
        }
      },

      questionOver: {
        _onEnter: async function(game) {
          // if the board is empty, move on to the next round
          game.data.questionsLeft -= 1;
          if (game.data.questionsLeft === 0) {
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
          this.emit('roundOver', {game});
          // check if we need to move into final jeopardy
          await delay(game.options.timeBetweenRounds);
          if (game.data.round === game.options.gameRounds) {
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
          this.emit('gameOver', {game});
        }
      }
    },

    // convenience functions

    Start: function(game) {
      this.handle(game, 'start');
    },

    Guess: function(game, player, guess) {
      this.handle(game, 'guess', player, guess);
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
    console.log(JSON.stringify(ev.game.data.question));
  });

  JepFsm.on('rightAnswer', ev => {
    console.log('Wow You Are Smarter, Much Smarter Than My Ex-Wife!', ev);
    console.log(`${ev.player} guessed ${ev.game.data.question.answer} right`);
    console.log(JSON.stringify(ev.game.data.scores));
  })

  JepFsm.on('wrongAnswer', ev => {
    console.log("You Fool!", ev);
    console.log(`player ${ev.player} guessed "${ev.guess} wrong"`);
    console.log(JSON.stringify(ev.game.data.scores));
  })

  JepFsm.on('noAnswer', ev => {
    console.log('Stumped Ya Good, Ya Dingus', ev);
    console.log(`answer was ${ev.game.data.question.answer}`);
  });

  JepFsm.on('roundOver', ev => {
    console.log('I May Be Square But Even I Can Tell This Round Is Over!', ev);
  });

  JepFsm.on('gameOver', ev => {
    console.log("Thank's For Playing!", ev);
  });

  const game = {channel: 123456};
  JepFsm.Start(game);

  // global.jep.Guess(global.game, 'sponge', 'hello')
  global.game = game;
  global.jep = JepFsm;
}

main();