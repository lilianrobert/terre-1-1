@echo off
rem Double-cliquez pour lancer la Terre 1:1 dans votre navigateur.
rem Gardez cette fenetre ouverte pendant que vous jouez ; fermez-la pour arreter.
cd /d "%~dp0"
start "" http://localhost:8765
python serve.py 8765
