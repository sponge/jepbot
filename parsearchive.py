import os
from tqdm import tqdm
from multiprocessing import Pool, TimeoutError
from glob import glob
from bs4 import BeautifulSoup
import re
import traceback
from collections import defaultdict
import sqlite3
from datetime import datetime

def parse_js(js):
    if 'clue_FJ' in js:
        round_num = 3
        category_num = 0
        level = 1
        value = re.findall(r"toggle\('.*', '.*', '(.*)'\)", js)[0]
    else:
        round_num, category_num, level, value = re.findall(
            r"toggle\('clue_(.*)_(\d)_(\d)', '.*', '(.*)'\)", js)[0]

        if round_num == "J":
            round_num = 1
        elif round_num == "DJ":
            round_num = 2
        elif round_num == "FJ":
            round_num = 3
        else:
            assert False, f"Couldn't parse round number {round_num}"

        category_num = int(category_num)
        level = int(level)

    value = value.replace("\\", "")

    return round_num, category_num, level, value


def parse_board(round_div):
    categories = [x.text for x in round_div.findAll(
        "td", {"class": "category_name"})]

    for c in categories:
        assert len(c) > 0, "Empty category name"

    clues = []
    clues_by_cateogry = defaultdict(list)

    clue_td = round_div.findAll("td", {"class": "clue"})

    for c in clue_td:
        if c.string == '\n':
            continue

        question_js = c.find('div')['onmouseout']
        answer_js = c.find('div')['onmouseover']

        round_num, category_num, level, question = parse_js(question_js)
        _, _, _, answer_dom = parse_js(answer_js)

        assert category_num - \
            1 < len(categories), f"Invalid category num {category_num}"
        assert level >= 1 and level <= 5, f"Invalid level {level}"
        assert question is not None and len(question) > 0, f"Empty question"

        category = categories[category_num - 1]

        answer_dom = BeautifulSoup(answer_dom, 'html.parser')
        answer = answer_dom.find("em", {"class": "correct_response"}).text

        assert answer is not None and len(answer) > 0, f"Empty answer"

        if "href" in question:
            continue

        if "href" in answer:
            continue

        question = question.replace('<br />', '\n')
        question = question.replace('<i>', '*')
        question = question.replace('</i>', '*')
        question = question.replace('<sub>', '')
        question = question.replace('</sub>', '')
        question = question.replace('<sup>', '')
        question = question.replace('</sup>', '')

        o = {
            "round": round_num,
            "category": category,
            "level": level,
            "question": question,
            "answer": answer
        }

        clues_by_cateogry[category].append(o)

    for k, v in clues_by_cateogry.items():
        if (len(v) != 5):
            # don't store incomplete categories at all
            continue
        clues.extend(v)

    return categories, clues, len(clue_td)


def parse_html(file):
    try:
        with open(file, 'r', encoding="utf-8") as html_doc:
            clues = []

            html = BeautifulSoup(html_doc, 'html.parser')

            game_id = re.findall(r"#(\d*)", html.title.text)
            assert len(
                game_id) == 1, "Did not find exactly 1 show number in title"
            game_id = int(game_id[0])

            airdate = re.findall(r"\d{4}-\d{2}-\d{2}", html.title.text)
            assert len(airdate) == 1, "Did not find exactly 1 date in title"
            airdate = datetime.strptime(airdate[0], "%Y-%m-%d").isoformat()

            for r in ['jeopardy_round', 'double_jeopardy_round']:
                round_div = html.find(id=r)
                if round_div is None:
                    # some games don't have boards at all
                    continue

                categories, round_clues, total_clues = parse_board(round_div)
                for c in round_clues:
                    c['game_id'] = game_id
                    c['airdate'] = airdate

                assert len(
                    categories) == 6, f"Didn't find 6 category names in board {r}"
                assert total_clues == 30, f"Didn't find 30 clue spots in board {r}"

                clues.extend(round_clues)

            try:
                round_div = html.find(id='final_jeopardy_round')
                category = round_div.find('td', {'class': 'category_name'}).text
                assert len(category) > 0, 'Final Jeopardy category length was 0'

                question_js = round_div.find('div')['onmouseout']
                answer_js = round_div.find('div')['onmouseover']

                _, _, _, question = parse_js(question_js)
                _, _, _, answer_dom = parse_js(answer_js)
                
                answer_dom = BeautifulSoup(answer_dom, 'html.parser')
                answer = answer_dom.find("em", {"class": "correct_response"}).text

                assert answer is not None and len(answer) > 0, f"Empty answer"

                o = {
                    "game_id": game_id,
                    "airdate": airdate,
                    "round": 3,
                    "category": category,
                    "level": 1,
                    "question": question,
                    "answer": answer
                }

                clues.append(o)
            except Exception:
                pass

            return clues
    except Exception as e:
        print(f'exception in {file}: {e.args}')
        return []


if __name__ == "__main__":
    results = []
    files = glob('./j-archive/*.html')

    # for f in tqdm(files):
    #     results.extend(parse_html(f))

    with Pool(8) as pool:
        for f in tqdm(pool.imap_unordered(parse_html, files), total=len(files), unit="games"):
            results.extend(f)

    with sqlite3.connect('clues.db') as conn:
        conn.execute('DROP TABLE IF EXISTS clues')
        conn.execute('''CREATE TABLE clues(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id INTEGER,
            airdate TEXT,
            round INTEGER,
            category TEXT,
            level INTEGER,
            question TEXT,
            answer TEXT
        )''')

        conn.execute('CREATE INDEX game_id_index ON clues(game_id)')
        conn.execute('CREATE INDEX airdate_index ON clues(airdate)')

        insert_values = [(x['game_id'], x['airdate'], x['round'], x['category'],
                          x['level'], x['question'], x['answer']) for x in results]
        conn.executemany(
            'INSERT INTO clues (game_id, airdate, round, category, level, question, answer) VALUES (?, ?, ?, ?, ?, ?, ?)', insert_values)

        conn.commit()
