"""
Медицинский портал 'My Dyatel'
Точка входа запуска веб-сервера (main.py)

Архитектура:
- ООП: Модели AbstractUser, AbstractDoctor, AbstractMedicalRecord
- База данных: SQLite 3 (damumed_portal.db)
- Стек фронтенда: HTML5, CSS3 (Bespoke Glassmorphism), JavaScript
"""

import sys
import os

# Добавляем корневую директорию проекта в sys.path
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from backend.server import run_server

if __name__ == "__main__":
    run_server()
