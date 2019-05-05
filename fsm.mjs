import sqlite from 'sqlite';
import machina from 'machina';
import delay from 'delay';
import distance from 'damerau-levenshtein';
import _ from 'lodash';

// drop all whitespace, and all symbols, and make lower case
function closeEnough(a, b, similarity) {
  return trimmedSimilarity(a, b).similarity >= similarity;
}

function trimmedSimilarity(a, b) {
  const regex = /\s|\W/gm;
  const trim_a = a.replace(regex, '').toLowerCase();
  const trim_b = b.replace(regex, '').toLowerCase();
  const score = distance(trim_a, trim_b);
  return score;
}

async function GetGameFSM() {
  const db = await sqlite.open('./clues.db', { Promise });

  return new machina.BehavioralFsm({
    namespace: 'jep',
    initialState: 'new',

    // fsm-specific options
    defaultGameOptions: {
      questionTime: 17000,            // how long players have to answer the question
      chooseQuestionTime: 10000,      // how long a player has to choose a question before a random one is picked
      timeBeforeAskQuestion: 5000,    // how long to wait after a question is chosen, to give people time to see the category
      timeBetweenQuestions: 6000,     // how long in between question answer/timeout and the next question selection
      timeBetweenRounds: 14000,       // how long in between rounds
      timeAfterRoundStart: 8000,      // how long after the board is generated and the round starts
      autoPickQuestions: false,       // randomly choose questions in a round, or let players choose them
      numRounds: 2,                   // how many regular rounds in a game
      playFinalRound: false,          // run the final round after numRounds rounds are complete
      guessesPerQuestion: 1,          // let players guess multiple times per question
      answerSimilarity: 0.6,          // how close correct answers need to be, see trimmedSimilarity and closeEnough for how this is measured
      numCategoriesPerRound: 6,       // number of categories selected per round
      numDailyDoublesPerRound: 2,     // number of daily doubles to randomly distribute through the board. 0 to disable
      wagerTime: 10000,               // how long a player has to wager for daily double/final jeopardy
    },

    states: {

      // setup game options and kick off the game
      new: {
        _onExit: function (game) {
          this.emit('gameStart', { game });
        },

        start: function (game, players) {
          game.options = { ...this.defaultGameOptions, ...game.options };

          // these two options don't make sense together
          if (game.options.autoPickQuestions) {
            game.options.numDailyDoublesPerRound = 0;
          }
  
          game.data = {
            round: 0,
            categories: [],
            board: [],
            scores: {},
            wagers: null,
            question: null,
            questionsAsked: 0,
            questionsLeft: 0,
            boardControl: null,
            timer: 0
          };

          if (players) {
            players.forEach(p => {
              game.data.scores[p] = 0;
            });
          }

          this.transition(game, 'roundStart');
        }
      },

      // a new round has started, fill up the board with questions
      roundStart: {
        _onEnter: async function (game) {
          const gd = game.data;
          gd.round += 1;

          // the player in last place selects the first clue in all rounds after the first
          if (gd.round !== 1) {
            gd.boardControl = _.minBy(Object.entries(gd.scores), o => o[1])[0];
          }

          if (gd.boardControl === null) {
            gd.boardControl = _.sample(Object.keys(gd.scores));
          }

          // select a random x categories from the db, then select all the clues in that category
          const results = await db.all(`
          SELECT a.* FROM clues a
          INNER JOIN 
            (SELECT DISTINCT category, game_id, round FROM clues WHERE round = ? AND airdate >= DATE('now', 'start of year', '-10 year') ORDER BY RANDOM() LIMIT ?) AS b
          ON a.category = b.category AND a.game_id = b.game_id AND a.round = b.round
          `, gd.round, game.options.numCategoriesPerRound);

          // get a list of our categories
          gd.categories = _.uniq(results.map(o => o.category));

          // make an empty array for each category
          gd.board = gd.categories.map(()=> []);

          // randomly select the daily double questions
          const dailyDoubles = _.sampleSize(results, game.options.numDailyDoublesPerRound);

          // add the questions into our board
          results.forEach(clue => {
            const idx = gd.categories.indexOf(clue.category);
            // if (dailyDoubles.includes(clue)) {
            //   console.log(`${clue.category}, ${clue.level}`);
            // }
            gd.board[idx].push({
              ...clue,
              enabled: true,
              dailyDouble: dailyDoubles.includes(clue),
              cost: gd.round * clue.level * 200
            });
          });

          // for easier tracking
          gd.questionsLeft = results.length;
          gd.questionsAsked = 0;

          // round is setup, move to select question phase
          this.emit('roundStart', { game, round: game.data.round });

          // wait some time before going to the next round
          await delay(game.options.timeAfterRoundStart);
          this.transition(game, 'selectQuestion');
        },
      },

      // pick a question from the board based on random or input
      selectQuestion: {
        _onEnter: function (game) {
          // null out data from previous question
          game.data.question = null;
          game.data.wagers = null;

          // if auto pick is on, find a question still enabled and just ask it immediately
          if (game.options.autoPickQuestions || game.data.questionsLeft === 1) {
            this.handle(game, 'chooseRandomQuestion');
          } else {
            this.emit('questionSelectReady', { game, board: game.data.board, player: game.data.boardControl });
            game.data.timer = setTimeout(() => this.handle(game, 'chooseRandomQuestion'), game.options.chooseQuestionTime);
          }
        },

        chooseRandomQuestion: function (game) {
          const questions = _.flatten(game.data.board).filter(clue => clue.enabled);
          const choice = _.sample(questions);

          this.handle(game, 'chooseQuestion', choice.category, choice.level, game.data.boardControl);
        },

        // handle and validate question selection. category is the exact string of the
        // category of the question, level is 1-5
        chooseQuestion: function (game, category, level, player) {
          // don't let players not in control of the board pick a question
          if (!game.options.autoPickQuestions && game.data.boardControl !== player) {
            return 'unknown';
          }

          // out of range questions
          const idx = game.data.categories.indexOf(category);
          if (idx == -1 || level < 1 || level > 5) {
            return 'unknown';
          }

          // must be whole numbers
          if (level !== Math.floor(level)) {
            return 'unknown';
          }

          // can't pick disabled questions
          const question = game.data.board[idx][level - 1];
          if (!question.enabled) {
            return 'unknown';
          }

          // question is valid, move on to asking it
          // we're not doing cleartimeout and transition in an _onExit so we can delay before moving to the next state
          game.data.question = question;
          this.emit('questionSelected', { game, question: game.data.question, player: game.data.boardControl });
          clearTimeout(game.data.timer);

          // wait an amount of time, so the players can be notified of what the category is before getting the question
          setTimeout(() => {
            // if it's a daily double, move onto asking the player for a wager, otherwise just ask the question
            const nextState = game.data.question.dailyDouble ? 'askWager' : 'askQuestion';
            this.transition(game, nextState);
          }, game.options.timeBeforeAskQuestion);
        }
      },

      // we're in a daily double, ask the player to wager an amount on the question
      askWager: {
        _onEnter: function (game) {
          const gd = game.data;

          gd.wagers = {};

          // if the question, setup a wager for the person who is controlling the board
          if (gd.question.dailyDouble === true) {
            gd.wagers[gd.boardControl] = null;
          }

          this.emit('askWager', { game, wagers: gd.wagers, type: 'dailydouble'});
          gd.timer = setTimeout(() => this.transition(game, 'askQuestion'), game.options.wagerTime);
        },

        _onExit: function (game) {
          // if the player hasn't bid, for daily doubles its the value of the clue, for final jeopardy it's everything
          for (const id in game.data.wagers) {
            if (game.data.wagers[id] === null) {
              game.data.wagers[id] === game.data.round > game.options.numRounds ? game.data.question.cost : game.data.scores[id];
            }
          }
          clearTimeout(game.data.timer);
        },

        // handles wager input usually from Command
        wager: function (game, player, amount) {
          const gd = game.data;

          // if they don't have a pending wager, ignore it
          if (player in gd.wagers === false) {
            return;
          }

          // the amount in the wager is subject to rules, get the range and check it here
          const range = this.GetValidWagerRange(game, player);
          if (amount < range[0] || amount > range[1]) {
            return 'badWager';
          }

          gd.wagers[player] = amount;

          this.emit('onWager', {game, player, amount});

          // if no more wagers are left, move on to asking the question immediately
          if (!Object.values(gd.wagers).includes(null)) {
            this.transition(game, 'askQuestion');
          }

          return 'wager';
        }
      },

      // ask the question, and handle input for answers/question timeout
      askQuestion: {
        _onEnter: function (game) {
          game.data.question.enabled = false;
          game.data.guesses = {};
          // setup question timeout if no one answers in time
          game.timer = setTimeout(() => {
            // if we timeout, anyone who wagers on the question and hasn't answered automatically loses the money
            if (game.data.wagers !== null) {
              Object.entries(game.data.wagers)
                .filter(wager => game.data.guesses[wager[0]] < game.options.guessesPerQuestion)
                .forEach(wager => game.data.scores[wager[0]] -= wager[1]);
            }
            // move on to the end of the answer
            this.transition(game, 'noAnswer');
          }, game.options.questionTime);
          this.emit('askQuestion', { game, question: game.data.question, wagers: game.data.wagers });
        },

        _onExit: function (game) {
          clearTimeout(game.timer);
        },

        // handle guesses from player
        guess: function (game, player, guess) {
          const gd = game.data;

          // if they're a new player, set them up
          if (!gd.scores[player]) {
            gd.scores[player] = 0;
          }

          // if they haven't guessed yet, set them up for this question
          if (!gd.guesses[player]) {
            gd.guesses[player] = 0;
          }

          // too many guesses
          if (gd.guesses[player] >= game.options.guessesPerQuestion) {
            return;
          }

          // if the question has wagers and they're not wagering, can't answer
          if (gd.wagers && !gd.wagers[player]) {
            return;
          }

          // check answer correctness
          if (closeEnough(guess, gd.question.answer, game.options.answerSimilarity)) {
            gd.scores[player] += gd.wagers && gd.wagers[player] ? gd.wagers[player] : gd.question.cost;
            gd.boardControl = player;
            this.emit('rightAnswer', { game, player, question: gd.question });
            this.transition(game, 'questionOver');
            return 'rightAnswer';
          } else {
            gd.scores[player] -= gd.wagers && gd.wagers[player] ? gd.wagers[player] : gd.question.cost;
            gd.guesses[player] += 1;
            this.emit('wrongAnswer', { game, player, guess, question: gd.question });
            return 'wrongAnswer';
          }
        }
      },

      // nobody guessed the answer in time. emit an event so we can print a message out and move on
      noAnswer: {
        _onEnter: function (game) {
          this.emit('noAnswer', { game, question: game.data.question });
          this.transition(game, 'questionOver');
        }
      },

      questionOver: {
        _onEnter: async function (game) {
          // if the board is empty, move on to the next round
          game.data.question = null;
          game.data.questionsLeft -= 1;
          game.data.questionsAsked += 1;
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
        _onEnter: async function (game) {
          // check if we need to move into final jeopardy
          await delay(game.options.timeBetweenRounds);
          if (game.data.round === game.options.numRounds) {
            if (game.options.playFinalRound) {
              // move into final round
            } else {
              this.transition(game, 'gameOver');
            }
          } else {
            this.emit('roundOver', { game });
            this.transition(game, 'roundStart');
          }
        }
      },

      gameOver: {
        _onEnter: function (game) {
          this.emit('gameOver', { game });
        }
      }
    },

    GetScores: function (game) {
      return Object.entries(game.data.scores).sort((a, b) => b[1] - a[1]);
    },

    GetValidWagerRange: function(game, player) {
      return [5, Math.max(game.data.scores[player], game.data.round * 500)];
    },

    Start: function (game, players) {
      this.handle(game, 'start', players);
    },

    Guess: function (game, player, guess) {
      return this.handle(game, 'guess', player, guess);
    },

    ChooseQuestion: function (game, category, level, player) {
      return this.handle(game, 'chooseQuestion', category, level, player);
    },

    Wager: function(game, player, amount) {
      return this.handle(game, 'wager', player, amount);
    },

    Command: function (game, player, command) {
      // if the line is in the form of a question, pass it into the fsm as a guess
      const matchGuess = /^(?:who|what|when|where)\s*(?:is|was|are)\s*(.*)/gmi.exec(command);
      if (matchGuess && matchGuess.length == 2) {
        return this.Guess(game, player, matchGuess[1]);
      }

      // wagers start with $, and can contain commas or periods. if they're not a number after that
      // then don't accept it as a wager
      if (command.startsWith('$')) {
        const amount = parseInt(command.replace(/(\$|,|\.)/gmi, ''), 10);

        if (isNaN(amount)) {
          return;
        }

        return this.Wager(game, player, amount);
      }

      // if command contains "for" see if words before are a category and after is a number, handle as category selection
      if (!game.options.autoPickQuestions) {
        const matchSelection = /(.*) for \$?(\d*)/gmi.exec(command);
        if (!matchSelection) {
          return;
        }

        const categoryNum = parseInt(matchSelection[1]);
        const amount = parseInt(matchSelection[2], 10);

        if (isNaN(amount) || isNaN(categoryNum)) {
          return;
        }

        let level = amount / game.data.round;
        // allow "2 for 1600" or "2 for 16"
        level /= level >= 100 ? 200 : 2;

        return this.ChooseQuestion(game, game.data.categories[categoryNum - 1], level, player);
      }
    }
  });
}

export default GetGameFSM;