FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    BOT_STATE_PATH=/data/state.json

WORKDIR /app
COPY bot.py attendance.py schedule.py ./
RUN mkdir -p /data

CMD ["python", "-u", "bot.py"]
