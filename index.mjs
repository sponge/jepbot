import sqlite from 'sqlite';
import machina from 'machina';
import delay from 'delay';
import distance from 'damerau-levenshtein';
import _ from 'lodash';

// drop all whitespace, and all symbols, and make lower case
function closeEnough(a, b, similarity) {
  return trimmedSimilarity(a, b).similarity >= similarity;
}

function trimmedSimilarity(a,b) {
  const regex = /\s|\W/gm;
  const trim_a = a.replace(regex, '').toLowerCase();
  const trim_b = b.replace(regex, '').toLowerCase();
  const score = distance(trim_a, trim_b);
  return score; 
}

async function main() {
  const db = await sqlite.open('./clues.db', { Promise });
  const clues = await db.all("select * from clues where airdate >= date('now','start of year','-1 year')");
  console.log(clues.length);
  global.clues = clues;

  const JepFsm = new machina.BehavioralFsm({
    namespace: 'jep',
    initialState: 'new',

    // fsm-specific options
    defaultGameOptions: {
      questionTime: 15000,            // how long players have to answer the question
      timeBetweenQuestions: 4000,     // how long in between question answer/timeout and the next question selection
      timeBetweenRounds: 8000,        // how long in between rounds
      autoPickQuestions: true,        // randomly choose questions in a round, or let players choose them
      gameRounds: 2,                  // how many regular rounds in a game
      playFinalRound: false,          // run the final round after gameRounds rounds are complete
      guessesPerQuestion: 1,          // let players guess multiple times per question
      answerSimilarity: 0.7,          // how close do answers need to be to be correct, uses damerau-lecenshtein string distance
      numCategoriesPerRound: 6,       // number of categories selected per round
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
            categories: [],
            board: [],
            scores: {},
            question: null,
            questionsLeft: 0,
            timer: 0
          };

          this.transition(game, 'roundStart')
        }
      },

      // a new round has started, fill up the board with questions
      roundStart: {
        _onEnter: async function(game) {
          const gd = game.data;
          gd.round += 1;

          // select a random x categories from the db, then select all the clues in that category
          const results = await db.all(`
          SELECT a.* FROM clues a
          INNER JOIN 
            (SELECT DISTINCT category, game_id FROM clues WHERE round = ? AND airdate >= DATE('now', 'start of year', '-1 year') ORDER BY RANDOM() LIMIT ?) AS b
          ON a.category = b.category AND a.game_id = b.game_id
          `, gd.round, game.options.numCategoriesPerRound);

          // get a list of our categories
          gd.categories = _.uniq(results.map(o => o.category));

          // make empty arrays for each of our board cells and add the questions to them
          gd.board = gd.categories.map(o => []);
          results.forEach(clue => {
            const idx = gd.categories.indexOf(clue.category);
            gd.board[idx].push({...clue, enabled: true, cost: gd.round * clue.level * 200});
          });

          // for easier tracking
          gd.questionsLeft = results.length;

          // round is setup, move to select question phase
          this.transition(game, 'selectQuestion');
        },

        _onExit: function(game) {
          this.emit('roundStart', {game, round: game.data.round});
        }
      },

      // pick a question from the board based on random or input
      selectQuestion: {
        _onEnter: function(game) {
          game.data.question = null;

          // if auto pick is on, find a question still active and just ask it immediately
          if (game.options.autoPickQuestions) {
            const questions = _.flatten(game.data.board).filter(clue => !clue.active);
            const choice = _.sample(questions);

            this.handle(game, 'chooseQuestion', choice.category, choice.level);
          }
        },

        _onExit: function(game) {
          this.emit('questionSelected', {game, question: game.data.question});
        },

        // handle and validate question selection. category is the exact string of the
        // category of the question, level is 1-5
        chooseQuestion: function(game, category, level, player) {
          const idx = game.data.categories.indexOf(category);

          if (idx == -1 || level < 1 || level > 5) {
            return;
          }

          const question = game.data.board[idx][level - 1];

          if (!question.enabled) {
            return;
          }

          // question is valid, move on to asking it
          game.data.question = question;
          this.transition(game, 'askQuestion');
        }
      },

      // ask the question, and handle input for answers/question timeout
      askQuestion: {
        _onEnter: function(game) {
          game.data.guesses = {};
          // setup question timeout if no one answers in time
          game.timer = setTimeout(() => this.transition(game, 'noAnswer'), game.options.questionTime);
        },

        _onExit: function(game) {
          clearTimeout(game.timer);
        },

        // handle guesses from player
        guess: function(game, player, guess) {
          const d = game.data;

          // if they're a new player, set them up
          if (!d.scores[player]) {
            d.scores[player] = 0;
          }

          // if they haven't guessed yet, set them up for this question
          if (!d.guesses[player]) {
            d.guesses[player] = 0;
          }

          // too many guesses
          if (d.guesses[player] >= game.options.guessesPerQuestion) {
            return;
          }

          // check answer correctness
          if (closeEnough(guess, d.question.answer, game.options.answerSimilarity)) {
            d.scores[player] += d.question.cost;
            this.emit('rightAnswer', {game, player});
            this.transition(game, 'questionOver');
          } else {
            d.scores[player] -= d.question.cost;
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
          game.data.question = null;
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
            if (game.options.playFinalRound) {
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
    },

    ChooseQuestion: function(game, category, level, player) {
      this.handle(game, 'chooseQuestion', category, level, player);
    },

    Command: function(game, player, command) {
      // if the line is in the form of a question, pass it into the fsm as a guess
      const matchGuess = /(?:who|what|when|where)\s*(?:is|was|are)\s*(.*)/gmi.exec(command);
      if (matchGuess && matchGuess.length == 2) {
        this.Guess(game, player, matchGuess[1]);
        return;
      }

      // if command contains "for" see if words before are a category and after is a number, handle as category selection
      if (!game.options.autoPickQuestions) {
        const matchSelection = /(.*) for \$?(\d*)/gmi.exec(command);
        if (!matchSelection) {
          return;
        }

        const playerCategory = matchSelection[1];
        const categoryNum = parseInt(playerCategory);
        const amount = parseInt(matchSelection[2], 10);
        const level = amount / game.data.round / 200;

        if (isNaN(amount)) {
          return;
        }

        if (isNaN(categoryNum)) {
          const distances = game.data.categories
            .map(category => [category, trimmedSimilarity(playerCategory, category)])
            .sort((a,b) => b[1].similarity - a[1].similarity);

          if (distances[0][1].similarity >= 0.5) {
            this.ChooseQuestion(game, ggame.data.categories.indexOf(distances[0][0]), level);
          }
        } else {
          this.ChooseQuestion(game, game.data.categories[categoryNum - 1], level);
        }
      }

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
    console.log(`${ev.question.category}\n$${ev.question.cost}\n${ev.question.question}\n(answer: ${ev.question.answer})`);
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

  // global.jep.COmmand(global.game, 'sponge', 'what is the answer')
  global.game = game;
  global.jep = JepFsm;
}

main();