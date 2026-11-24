FROM python:3.11-slim
WORKDIR /app
COPY server.py ./
COPY data ./data
COPY public ./public
ENV PORT=3000
ENV DATA_DIR=/app/data
EXPOSE 3000
CMD ["python", "server.py"]
