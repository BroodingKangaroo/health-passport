from app.services.language_detect import detect_source_language

RU = (
    "Общий анализ крови. Гемоглобин 145 г/л. Лейкоциты 6.2. "
    "Пациент: Иванов И.И. Дата: 26.05.2026. Результаты исследования крови "
    "показывают норму, врач подтверждает заключение."
)
DE = (
    "Allgemeine Blutuntersuchung. Die Ergebnisse der Untersuchung sind im "
    "Normalbereich. Der Patient war nicht nüchtern. Befund und Beurteilung "
    "des Arztes liegen der Klinik vor."
)
FR = (
    "Analyse du sang. Le patient est venu pour une analyse. Les résultats "
    "sont dans les limites de la normale et le médecin a validé le compte "
    "rendu de la clinique."
)
ES = (
    "Análisis de sangre. El paciente acudió para un análisis. Los resultados "
    "están dentro de los límites normales y el médico revisó el informe con "
    "atención por la tarde."
)
EN = (
    "Complete blood count. The patient came in for a blood test. The results "
    "are within the reference range and the doctor reviewed the report with "
    "the patient and the clinic."
)
PL = (
    "Badanie krwi. Pacjent zgłosił się na badanie krwi. Wyniki są w granicach "
    "normy oraz lekarz obejrział wyniki badania krwi pacjenta w tygodniu."
)
HE = (
    "ספירת דם מלאה. המטופל הגיע לבדיקת דם בבוקר. התוצאות בטווח התקין והרופא "
    "בדק את הדוח עם המטופל ונתן לו הסבר מלא על התוצאות."
)


class TestDetectSourceLanguage:
    def test_russian_by_cyrillic_script(self):
        assert detect_source_language(RU) == "ru"

    def test_hebrew_by_script(self):
        assert detect_source_language(HE) == "he"

    def test_german(self):
        assert detect_source_language(DE) == "de"

    def test_french(self):
        assert detect_source_language(FR) == "fr"

    def test_spanish(self):
        assert detect_source_language(ES) == "es"

    def test_english(self):
        assert detect_source_language(EN) == "en"

    def test_polish(self):
        assert detect_source_language(PL) == "pl"

    def test_empty_text_is_none(self):
        assert detect_source_language("") is None

    def test_none_text_is_none(self):
        assert detect_source_language(None) is None

    def test_short_text_is_none(self):
        assert detect_source_language("Hgb 145 g/l") is None

    def test_cyrillic_dominant_mixed_document_is_ru(self):
        # Script pass fires first: a mostly-Russian lab report with a few
        # English footer words is still Russian.
        mixed = RU + " The and of with for patient test."
        assert detect_source_language(mixed) == "ru"

    def test_latin_tie_is_none(self):
        # German and English hit counts too close to call — no winner.
        tie = ("der die das und der die das und " "the and of with the and of with ") * 2
        assert detect_source_language(tie) is None

    def test_numbers_only_is_none(self):
        assert detect_source_language("145 6.2 4.0 11.0 150 45 98.6 12 5 2026 26 05 15") is None
