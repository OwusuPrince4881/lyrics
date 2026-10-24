"""
conftest.py — pytest session-wide path configuration.

Adds backend/ to sys.path so tests can import pipeline directly
without each test file needing its own sys.path.insert() call.
"""
import os
import sys

# Make `import pipeline` work from any test file
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
