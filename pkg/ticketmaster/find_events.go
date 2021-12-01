package ticketmaster

import "time"

type FindEventsQuery struct {
	Zipcode string
}

type FindEventsResponse struct {
	Links struct {
		Self struct {
			Href      string `json:"href"`
			Templated bool   `json:"templated"`
		} `json:"self"`
		Next struct {
			Href      string `json:"href"`
			Templated bool   `json:"templated"`
		} `json:"next"`
	} `json:"_links"`
	Embedded struct {
		Events []struct {
			Name   string `json:"name"`
			Type   string `json:"type"`
			ID     string `json:"id"`
			Test   bool   `json:"test"`
			URL    string `json:"url"`
			Locale string `json:"locale"`
			Images []struct {
				Ratio    string `json:"ratio"`
				URL      string `json:"url"`
				Width    int    `json:"width"`
				Height   int    `json:"height"`
				Fallback bool   `json:"fallback"`
			} `json:"images"`
			Sales struct {
				Public struct {
					StartDateTime time.Time `json:"startDateTime"`
					StartTBD      bool      `json:"startTBD"`
					EndDateTime   time.Time `json:"endDateTime"`
				} `json:"public"`
			} `json:"sales"`
			Dates struct {
				Start struct {
					LocalDate      string `json:"localDate"`
					DateTBD        bool   `json:"dateTBD"`
					DateTBA        bool   `json:"dateTBA"`
					TimeTBA        bool   `json:"timeTBA"`
					NoSpecificTime bool   `json:"noSpecificTime"`
				} `json:"start"`
				Timezone string `json:"timezone"`
				Status   struct {
					Code string `json:"code"`
				} `json:"status"`
			} `json:"dates"`
			Classifications []struct {
				Primary bool `json:"primary"`
				Segment struct {
					ID   string `json:"id"`
					Name string `json:"name"`
				} `json:"segment"`
				Genre struct {
					ID   string `json:"id"`
					Name string `json:"name"`
				} `json:"genre"`
				SubGenre struct {
					ID   string `json:"id"`
					Name string `json:"name"`
				} `json:"subGenre"`
			} `json:"classifications"`
			Promoter struct {
				ID string `json:"id"`
			} `json:"promoter"`
			Links struct {
				Self struct {
					Href string `json:"href"`
				} `json:"self"`
				Attractions []struct {
					Href string `json:"href"`
				} `json:"attractions"`
				Venues []struct {
					Href string `json:"href"`
				} `json:"venues"`
			} `json:"_links"`
			Embedded struct {
				Venues []struct {
					Name       string `json:"name"`
					Type       string `json:"type"`
					ID         string `json:"id"`
					Test       bool   `json:"test"`
					Locale     string `json:"locale"`
					PostalCode string `json:"postalCode"`
					Timezone   string `json:"timezone"`
					City       struct {
						Name string `json:"name"`
					} `json:"city"`
					State struct {
						Name      string `json:"name"`
						StateCode string `json:"stateCode"`
					} `json:"state"`
					Country struct {
						Name        string `json:"name"`
						CountryCode string `json:"countryCode"`
					} `json:"country"`
					Address struct {
						Line1 string `json:"line1"`
					} `json:"address"`
					Location struct {
						Longitude string `json:"longitude"`
						Latitude  string `json:"latitude"`
					} `json:"location"`
					Markets []struct {
						ID string `json:"id"`
					} `json:"markets"`
					Links struct {
						Self struct {
							Href string `json:"href"`
						} `json:"self"`
					} `json:"_links"`
				} `json:"venues"`
				Attractions []struct {
					Name   string `json:"name"`
					Type   string `json:"type"`
					ID     string `json:"id"`
					Test   bool   `json:"test"`
					Locale string `json:"locale"`
					Images []struct {
						Ratio    string `json:"ratio"`
						URL      string `json:"url"`
						Width    int    `json:"width"`
						Height   int    `json:"height"`
						Fallback bool   `json:"fallback"`
					} `json:"images"`
					Classifications []struct {
						Primary bool `json:"primary"`
						Segment struct {
							ID   string `json:"id"`
							Name string `json:"name"`
						} `json:"segment"`
						Genre struct {
							ID   string `json:"id"`
							Name string `json:"name"`
						} `json:"genre"`
						SubGenre struct {
							ID   string `json:"id"`
							Name string `json:"name"`
						} `json:"subGenre"`
					} `json:"classifications"`
					Links struct {
						Self struct {
							Href string `json:"href"`
						} `json:"self"`
					} `json:"_links"`
				} `json:"attractions"`
			} `json:"_embedded"`
		} `json:"events"`
	} `json:"_embedded"`
	Page struct {
		Size          int `json:"size"`
		TotalElements int `json:"totalElements"`
		TotalPages    int `json:"totalPages"`
		Number        int `json:"number"`
	} `json:"page"`
}
