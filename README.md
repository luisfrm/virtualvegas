# virtualvegas

## Project setup
```
pip install -r requirements.txt
```

## Run
```
python ./telegrambot/bot.py
```

## Docker
```
docker build -t virtualvegas .
docker run -it --rm --name virtualvegas1 virtualvegas
```

--it: interactive mode
--rm: remove the container after exiting
--name: name of the container