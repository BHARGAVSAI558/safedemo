from app.services.cpcb_aqi import aqi_category, combined_aqi, cpcb_sub_index_pm25


def test_pm25_index_good_bucket():
    assert cpcb_sub_index_pm25(15.0) <= 50


def test_combined_aqi_uses_max_subindex():
    aqi = combined_aqi(100.0, 40.0)
    assert aqi > 100


def test_category_hazardous():
    assert aqi_category(450) == "Hazardous"
