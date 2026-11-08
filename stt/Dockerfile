FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 HF_HOME=/models
RUN pip install --no-cache-dir faster-whisper==1.2.1 av==18.1.0
WORKDIR /srv
COPY stt_server.py .
CMD ["python", "stt_server.py"]
